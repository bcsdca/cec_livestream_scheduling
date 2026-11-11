import { google } from "googleapis";
import nodemailer from "nodemailer";
import { DateTime } from "luxon";
import { config } from "./config.mjs";
import { authorize } from "./auth.mjs";
import { verifyYouTubeAuth } from "./verify-auth.mjs";

// ============================================================
// Configuration
// ============================================================

const {
  PERSISTENT_STREAM_ID_SANCTUARY,
  PERSISTENT_STREAM_ID_FELLOWSHIP,
  CHURCH_CHANNEL_ID,
} = config;

const TIME_ZONE = "America/Los_Angeles";
const CONFLICT_WINDOW_MINUTES = 30;

const errorLogs = [];
const warningLogs = [];

// Capture actual errors for the summary email.
// Recoverable retry warnings use console.log instead.
const originalConsoleError = console.error;

console.error = (...args) => {
  const message = args.map(arg => {
    if (typeof arg === "string") return arg;

    try {
      return JSON.stringify(arg, null, 2);
    } catch {
      return String(arg);
    }
  }).join(" ");

  errorLogs.push(message);
  originalConsoleError(...args);
};

console.log(
  `\n=== Script run at: ${
    DateTime.now().setZone(TIME_ZONE)
      .toFormat("yyyy-MM-dd HH:mm:ss ZZZZ")
  } ===`
);

// ============================================================
// YouTube API Error Logging
// ============================================================

function logYouTubeError(operation, err) {
  const response = err.response;
  const apiError = response?.data?.error;

  console.error(`\n❌ YouTube API failed: ${operation}`);
  console.error(`- HTTP Status: ${response?.status || "Unknown"}`);
  console.error(`- Error Message: ${err.message}`);
  console.error(`- API Error Code: ${apiError?.code || "Unknown"}`);
  console.error(`- API Error Message: ${apiError?.message || "Unknown"}`);

  for (const detail of apiError?.errors || err.errors || []) {
    console.error(`- Reason: ${detail.reason || "Unknown"}`);
    console.error(`- Domain: ${detail.domain || "Unknown"}`);
    console.error(`- Detail: ${detail.message || "Unknown"}`);

    if (detail.location) {
      console.error(`- Location: ${detail.location}`);
    }
  }

  if (apiError?.details) {
    console.error(
      "- API Details:",
      JSON.stringify(apiError.details, null, 2)
    );
  }

  if (response?.headers?.["x-goog-request-id"]) {
    console.error(
      `- Google Request ID: ${
        response.headers["x-goog-request-id"]
      }`
    );
  }

  console.error("-------------------------------------------");
}

// ============================================================
// Retry YouTube API Operation
// ============================================================

// Retry potentially temporary failures.
// Do not use this function for liveBroadcasts.insert().
async function retryYouTubeOperation(
  operation,
  callback,
  serviceName,
  maxAttempts = 3
) {
  const delays = [3000, 5000];
  const failedAttempts = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await callback();

      if (attempt > 1) {
        const warning =
          `${serviceName}\n` +
          `  ${operation}: ${failedAttempts.join("; ")}\n` +
          `  Recovered: succeeded on attempt ${attempt}.`;

        warningLogs.push(warning);

        console.log(
          `✅ ${serviceName}: ${operation} succeeded on attempt ${attempt}.`
        );
      }

      return result;

    } catch (err) {
      const status = Number(
        err.response?.status || err.code
      );

      const reasons = (
        err.response?.data?.error?.errors || []
      )
        .map(e => e.reason)
        .filter(Boolean);

      const retryableReasons = [
        "backendError",
        "internalError",
        "rateLimitExceeded",
        "userRateLimitExceeded",
      ];

      const retryable =
        [429, 500, 502, 503, 504].includes(status) ||
        (
          status === 403 &&
          (
            reasons.some(r =>
              retryableReasons.includes(r)
            ) ||
            reasons.length === 0 ||
            reasons.every(r => r === "forbidden")
          )
        );

      const failureDetail =
        `attempt ${attempt}/${maxAttempts} failed: ` +
        `${err.message} (HTTP ${status || "Unknown"})` +
        (
          reasons.length
            ? ` [${reasons.join(", ")}]`
            : ""
        );

      failedAttempts.push(failureDetail);

      // Temporary failures are warnings, not final errors.
      console.log(
        `⚠️ ${serviceName}: ${operation} ${failureDetail}`
      );

      if (!retryable || attempt === maxAttempts) {
        // Only unrecovered failures become actual errors.
        logYouTubeError(
          `${serviceName} - ${operation}`,
          err
        );

        throw err;
      }

      const delay = delays[attempt - 1] || 5000;

      console.log(
        `⏳ Retrying ${serviceName}: ${operation} ` +
        `in ${delay / 1000} seconds...`
      );

      await new Promise(
        resolve => setTimeout(resolve, delay)
      );
    }
  }
}

// ============================================================
// Verify YouTube Channel
// ============================================================

async function verifyChannel(auth) {
  const youtube = google.youtube({
    version: "v3",
    auth,
  });

  try {
    const res = await youtube.channels.list({
      part: "id,snippet",
      mine: true,
    });

    const channel = res.data.items?.find(
      item => item.id === CHURCH_CHANNEL_ID
    );

    if (!channel) {
      console.error(
        "❌ Authenticated channel does not match the church channel."
      );
      console.error(
        `- Expected Channel ID: ${CHURCH_CHANNEL_ID}`
      );

      return false;
    }

    console.log(
      `✅ Verified church channel: ` +
      `${channel.snippet?.title} (${channel.id})`
    );

    return true;

  } catch (err) {
    logYouTubeError("channels.list", err);
    return false;
  }
}

// ============================================================
// Calculate Next Sunday
// ============================================================

function getNextSundayDateTime(hour, minute) {
  const now = DateTime.now().setZone(TIME_ZONE);

  return now.plus({
    days: (7 - now.weekday) % 7 || 7,
  }).set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
}

// ============================================================
// Verify Persistent Stream IDs
// ============================================================

async function verifyConfiguredStreamIds(auth) {
  const youtube = google.youtube({
    version: "v3",
    auth,
  });

  const configuredStreams = [
    {
      name: "Sanctuary / Joint Worship",
      streamId: PERSISTENT_STREAM_ID_SANCTUARY,
    },
    {
      name: "Fellowship / Mandarin",
      streamId: PERSISTENT_STREAM_ID_FELLOWSHIP,
    },
  ];

  console.log("\n=== Preflight Stream ID Check ===");

  let allValid = true;

  for (const stream of configuredStreams) {
    try {
      const res = await youtube.liveStreams.list({
        part: "id,snippet,status,contentDetails",
        id: stream.streamId,
      });

      const item = res.data.items?.find(
        s => s.id === stream.streamId
      );

      if (!item) {
        console.error(
          `❌ ${stream.name} stream does not exist.`
        );

        allValid = false;
        continue;
      }

      if (
        item.snippet?.channelId !==
        CHURCH_CHANNEL_ID
      ) {
        console.error(
          `❌ ${stream.name} belongs to the wrong channel.`
        );

        allValid = false;
        continue;
      }

      if (
        item.contentDetails?.isReusable !== true
      ) {
        console.error(
          `❌ ${stream.name} is not reusable.`
        );

        allValid = false;
        continue;
      }

      console.log(
        `✅ ${stream.name} stream verified.`
      );
      console.log(
        `- Title: ${item.snippet?.title || "Unknown"}`
      );
      console.log(`- Stream ID: ${item.id}`);
      console.log(
        `- Status: ${
          item.status?.streamStatus || "Unknown"
        }`
      );
      console.log(
        `- Reusable: ${
          item.contentDetails.isReusable
        }`
      );

    } catch (err) {
      logYouTubeError(
        `liveStreams.list (${stream.name})`,
        err
      );

      allValid = false;
    }
  }

  if (!allValid) {
    console.error(
      "❌ PRECHECK FAILED. No broadcasts will be created."
    );

    return false;
  }

  console.log(
    "✅ All configured YouTube Stream IDs passed preflight."
  );
  console.log("-------------------------------------------");

  return true;
}

// ============================================================
// Detect Duplicate or Conflicting Broadcasts
// ============================================================

async function hasConflictingBroadcast(
  auth,
  streamId,
  newStartTime,
  title
) {
  const youtube = google.youtube({
    version: "v3",
    auth,
  });

  try {
    let pageToken;
    let checked = 0;

    do {
      const res = await youtube.liveBroadcasts.list({
        part: "id,snippet,contentDetails",
        broadcastStatus: "upcoming",
        maxResults: 50,
        ...(pageToken ? { pageToken } : {}),
      });

      for (const item of res.data.items || []) {
        checked++;

        const existingStartStr =
          item.snippet?.scheduledStartTime;

        if (!existingStartStr) continue;

        const existingStart =
          DateTime.fromISO(existingStartStr)
            .setZone(TIME_ZONE);

        if (!existingStart.isValid) continue;

        const minutesApart = Math.abs(
          existingStart
            .diff(newStartTime, "minutes")
            .minutes
        );

        const sameTitle =
          item.snippet?.title === title;

        const sameTime =
          minutesApart < 1;

        const sameStream =
          item.contentDetails?.boundStreamId ===
          streamId;

        const overlappingStream =
          sameStream &&
          minutesApart < CONFLICT_WINDOW_MINUTES;

        if (
          (sameTitle && sameTime) ||
          overlappingStream
        ) {
          console.error(
            "❌ Conflicting or duplicate livestream found."
          );
          console.error(
            `- Title: ${item.snippet?.title}`
          );
          console.error(
            `- Broadcast ID: ${item.id}`
          );
          console.error(
            `- Scheduled Start: ${
              existingStart.toFormat(
                "yyyy-MM-dd HH:mm"
              )
            }`
          );
          console.error(
            `- Bound Stream ID: ${
              item.contentDetails?.boundStreamId ||
              "None"
            }`
          );
          console.error(
            `- Conflict Type: ${
              sameTitle && sameTime
                ? "Duplicate title and time"
                : "Overlapping stream"
            }`
          );

          return true;
        }
      }

      pageToken =
        res.data.nextPageToken;

    } while (pageToken);

    console.log(
      `✅ No conflicting broadcast found ` +
      `(${checked} upcoming checked).`
    );

    return false;

  } catch (err) {
    logYouTubeError(
      "liveBroadcasts.list",
      err
    );

    throw err;
  }
}

// ============================================================
// Delete Incomplete Broadcast
// ============================================================

async function deleteIncompleteBroadcast(
  youtube,
  broadcastId
) {
  try {
    console.log(
      `🧹 Deleting incomplete broadcast: ${broadcastId}`
    );

    await youtube.liveBroadcasts.delete({
      id: broadcastId,
    });

    console.log(
      `✅ Deleted incomplete broadcast: ${broadcastId}`
    );

    return true;

  } catch (err) {
    logYouTubeError(
      "liveBroadcasts.delete",
      err
    );

    console.error(
      `❌ Manual cleanup required for broadcast: ${broadcastId}`
    );

    return false;
  }
}

// ============================================================
// Schedule One Livestream
// ============================================================

async function scheduleLivestream(
  auth,
  titlePrefix,
  hour,
  minute,
  streamId
) {
  const youtube = google.youtube({
    version: "v3",
    auth,
  });

  const sunday =
    getNextSundayDateTime(hour, minute);

  const title =
    `${sunday.toFormat("M/d/yy")} ${titlePrefix}`;

  const description =
    titlePrefix.includes("English")
      ? `We hope to connect with you! Send us an email.\ninfo@cec-sd.org\n\nFor more info, please check out our website.\nhttps://cec-sd.org`
      : title;

  if (
    await hasConflictingBroadcast(
      auth,
      streamId,
      sunday,
      title
    )
  ) {
    throw new Error(
      `Conflicting or duplicate scheduled livestream: ${title}`
    );
  }

  let broadcastId;

  try {
    // --------------------------------------------------------
    // Step 1: Create Broadcast
    // --------------------------------------------------------

    console.log(
      `\n🔄 Creating broadcast: ${title}`
    );

    const broadcastRes =
      await youtube.liveBroadcasts.insert({
        part: "snippet,contentDetails,status",
        requestBody: {
          snippet: {
            title,
            description,
            scheduledStartTime:
              sunday.toISO(),
          },
          status: {
            privacyStatus: "public",
          },
          contentDetails: {
            monitorStream: {
              enableMonitorStream: false,
            },
            enableAutoStart: false,
            enableAutoStop: false,
            enableDvr: true,
            recordFromStart: true,
            startWithSlate: false,
            enableClosedCaptions: false,
            enableContentEncryption: false,
            enableEmbed: true,
            enableLowLatency: false,
            liveChatEnabled: false,
          },
        },
      });

    broadcastId =
      broadcastRes.data?.id;

    if (!broadcastId) {
      throw new Error(
        "Broadcast creation returned no broadcast ID."
      );
    }

    console.log(
      `✅ Broadcast created: ${broadcastId}`
    );

    // --------------------------------------------------------
    // Step 2: Update Video Metadata (With Retries)
    // --------------------------------------------------------

    console.log(
      `🔄 Updating video metadata: ${broadcastId}`
    );

    await retryYouTubeOperation(
      "videos.update",
      () => youtube.videos.update({
        part: "snippet",
        requestBody: {
          id: broadcastId,
          snippet: {
            title,
            description,
            categoryId: "29",
          },
        },
      }),
      titlePrefix
    );

    console.log(
      `✅ Video metadata updated: ${broadcastId}`
    );

    // --------------------------------------------------------
    // Step 3: Bind Broadcast to Persistent Stream
    // --------------------------------------------------------

    console.log(
      `🔄 Binding broadcast: ${broadcastId}`
    );
    console.log(
      `- Requested Stream ID: ${streamId}`
    );

    let boundStreamId;

    try {
      const bindRes =
        await youtube.liveBroadcasts.bind({
          id: broadcastId,
          part: "id,contentDetails",
          streamId,
        });

      boundStreamId =
        bindRes.data?.contentDetails
          ?.boundStreamId;

      if (boundStreamId !== streamId) {
        throw new Error(
          `Bind verification failed: expected ${streamId}, ` +
          `received ${
            boundStreamId || "none"
          }`
        );
      }

      console.log(
        `✅ Stream binding verified: ${boundStreamId}`
      );

    } catch (err) {
      logYouTubeError(
        "liveBroadcasts.bind",
        err
      );

      throw err;
    }

    const youtubeLink =
      `https://www.youtube.com/watch?v=${broadcastId}`;

    console.log(
      `✅ Scheduled livestream: ${title}`
    );
    console.log(
      `- Broadcast ID: ${broadcastId}`
    );
    console.log(
      `- Scheduled Start Time: ${
        sunday.toFormat("yyyy-MM-dd HH:mm")
      } Pacific`
    );
    console.log(
      `- Requested Stream ID: ${streamId}`
    );
    console.log(
      `- Bound Stream ID: ${boundStreamId}`
    );
    console.log(
      `- YouTube Link: ${youtubeLink}`
    );
    console.log(
      "-------------------------------------------"
    );

    return {
      success: true,
      title,
      youtubeLink,
    };

  } catch (err) {
    if (broadcastId) {
      await deleteIncompleteBroadcast(
        youtube,
        broadcastId
      );
    }

    throw new Error(
      `Failed to schedule ${title}: ${err.message}`
    );
  }
}

// ============================================================
// Send Summary Email
// ============================================================

async function sendEmail(
  successes,
  failures
) {
  const transporter =
    nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: config.EMAIL_SENDER,
        pass: config.EMAIL_PASSWORD,
      },
    });

  let emailBody =
    "Here are the results for the scheduled YouTube livestreams for this Sunday:\n\n";

  // ----------------------------------------------------------
  // Successes
  // ----------------------------------------------------------

  if (successes.length) {
    emailBody += "✅ Successes:\n";

    emailBody += successes
      .map(s =>
        `- ${s.title}\n  ${s.youtubeLink}`
      )
      .join("\n\n") + "\n\n";

  } else {
    emailBody +=
      "✅ Successes: None\n\n";
  }

  // ----------------------------------------------------------
  // Failures
  // ----------------------------------------------------------

  if (failures.length) {
    emailBody += "❌ Failures:\n";

    emailBody += failures
      .map(f =>
        `- ${f.title}\n  Error: ${f.error}`
      )
      .join("\n\n") + "\n\n";

  } else {
    emailBody +=
      "❌ Failures: None\n\n";
  }

  // ----------------------------------------------------------
  // Warning Logs
  // ----------------------------------------------------------

  if (warningLogs.length) {
    emailBody += "⚠️ Warning Logs:\n";

    emailBody += warningLogs
      .map(log => `- ${log}`)
      .join("\n\n") + "\n\n";
  }

  // ----------------------------------------------------------
  // Error Logs
  // ----------------------------------------------------------

  if (errorLogs.length) {
    emailBody += "❌ Error Logs:\n";

    emailBody += errorLogs
      .map(log => `- ${log}`)
      .join("\n") + "\n";
  }

  const formattedNextSunday =
    getNextSundayDateTime(9, 15)
      .toFormat("M/d/yy");

  try {
    await transporter.sendMail({
      from: config.EMAIL_SENDER,
      to: Array.isArray(
        config.EMAIL_RECIPIENTS
      )
        ? config.EMAIL_RECIPIENTS.join(", ")
        : config.EMAIL_RECIPIENTS,
      subject:
        `CEC YouTube Livestream Scheduling Summary For This Sunday (${formattedNextSunday})`,
      text: emailBody,
    });

    console.log(
      "✅ Summary email sent."
    );

    return true;

  } catch (err) {
    console.error(
      `❌ Failed to send summary email: ${err.message}`
    );

    if (err.code === "EAUTH") {
      console.error(
        "❌ Gmail authentication failed. Check Gmail App Password."
      );
    }

    return false;
  }
}

// ============================================================
// Main
// ============================================================

(async () => {
  try {
    const auth = await authorize();

    // --------------------------------------------------------
    // Preflight Authentication Check
    // --------------------------------------------------------

    if (
      !(await verifyYouTubeAuth(auth))
    ) {
      console.error(
        "❌ Aborting: YouTube authentication failed."
      );

      await sendEmail([], [{
        title:
          "Preflight Authentication Check",
        error:
          "YouTube authentication failed.",
      }]);

      process.exitCode = 1;
      return;
    }

    // --------------------------------------------------------
    // Preflight Channel Check
    // --------------------------------------------------------

    if (
      !(await verifyChannel(auth))
    ) {
      await sendEmail([], [{
        title:
          "Preflight Channel Check",
        error:
          "Authenticated channel does not match the church channel.",
      }]);

      process.exitCode = 1;
      return;
    }

    // --------------------------------------------------------
    // Preflight Stream ID Check
    // --------------------------------------------------------

    if (
      !(await verifyConfiguredStreamIds(auth))
    ) {
      await sendEmail([], [{
        title:
          "Preflight Stream ID Check",
        error:
          "One or more configured persistent streams are invalid.",
      }]);

      process.exitCode = 1;
      return;
    }

    // --------------------------------------------------------
    // Production Worship Schedule
    // --------------------------------------------------------

    const streams = [
      {
        title:
          "English Sunday Worship",
        hour: 9,
        minute: 15,
        streamId:
          PERSISTENT_STREAM_ID_SANCTUARY,
      },
      {
        title:
          "Mandarin Sunday Worship 國語主日崇拜",
        hour: 9,
        minute: 15,
        streamId:
          PERSISTENT_STREAM_ID_FELLOWSHIP,
      },
      {
        title:
          "Cantonese Sunday Worship 粵語主日崇拜",
        hour: 11,
        minute: 0,
        streamId:
          PERSISTENT_STREAM_ID_SANCTUARY,
      },
    ];

    const successes = [];
    const failures = [];

    // --------------------------------------------------------
    // Schedule Each Livestream
    // --------------------------------------------------------

    for (const s of streams) {
      try {
        const result =
          await scheduleLivestream(
            auth,
            s.title,
            s.hour,
            s.minute,
            s.streamId
          );

        successes.push(result);

      } catch (err) {
        console.error(
          `❌ Failed to schedule: ${s.title} — ${err.message}`
        );

        failures.push({
          title: s.title,
          error: err.message,
        });
      }
    }

    // --------------------------------------------------------
    // Send Email Summary
    // --------------------------------------------------------

    const emailSent =
      await sendEmail(
        successes,
        failures
      );

    console.log(
      `\nScript completed. ` +
      `${successes.length} success(es), ` +
      `${failures.length} failure(s).`
    );

    if (
      failures.length ||
      !emailSent
    ) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error(
      "❌ Top-level error:",
      err.message
    );

    await sendEmail([], [{
      title: "Top-level error",
      error: err.message,
    }]);

    process.exitCode = 1;
  }
})();

