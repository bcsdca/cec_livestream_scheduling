// schedule-all-streams.mjs (patched)
import fs from "fs";
import { google } from "googleapis";
import readline from "readline";
import open from "open";
import nodemailer from "nodemailer";
import { DateTime, Interval } from "luxon";
import { config } from "./config.mjs";
import { authorize } from "./auth.mjs";
import { verifyYouTubeAuth } from "./verify-auth.mjs";
import { handleOAuthError } from "./auth.mjs";

const errorLogs = [];

const originalConsoleError = console.error;
console.error = (...args) => {
  const message = args.map(arg =>
    typeof arg === "string"
      ? arg
      : (() => {
          try {
            return JSON.stringify(arg, null, 2);
          } catch {
            return String(arg);
          }
        })()
    ).join(" ");
  errorLogs.push(message);
  originalConsoleError(...args);
};

const {
  PERSISTENT_STREAM_ID_SANCTUARY,
  PERSISTENT_STREAM_ID_FELLOWSHIP,
  CHURCH_CHANNEL_ID,
} = config;

const CONFLICT_WINDOW_MINUTES = 30;

const runTime = DateTime.now().setZone("America/Los_Angeles").toFormat("yyyy-MM-dd HH:mm:ss");
console.log(`\n=== Script run at: ${runTime} PST ===`);

async function verifyChannel(auth) {
  const youtube = google.youtube({ version: "v3", auth });
  const res = await youtube.channels.list({ part: "id,snippet", mine: true });

  const channel = res.data.items?.[0];
  if (!channel) return console.error("❌ No channel found for this account.");

  if (channel.id !== CHURCH_CHANNEL_ID) {
    console.error(`❌ Aborting: Unauthorized YouTube channel.`);
    console.error(`- Authenticated Channel Name: ${channel.snippet.title}`);
    console.error(`- Authenticated Channel ID: ${channel.id}`);
    console.error(`- Expected Church Channel ID: ${CHURCH_CHANNEL_ID}`);
    return false;
  }

  console.log(`✅ Verified church channel: ${channel.snippet.title} (${channel.id})`);
  return true;
}

function getNextSundayDateTime(hour, minute) {
  const now = DateTime.now().setZone("America/Los_Angeles");
  const nextSunday = now.plus({ days: (7 - now.weekday) % 7 || 7 }).set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
  return nextSunday;
}

async function hasConflictingBroadcast(auth, streamId, newStartTime) {
  const youtube = google.youtube({ version: "v3", auth });

  try {
    const res = await youtube.liveBroadcasts.list({
      part: "snippet,contentDetails",
      broadcastStatus: "upcoming",
      maxResults: 25,
      channelId: CHURCH_CHANNEL_ID,
    });

    for (const item of res.data.items || []) {
      const boundStreamId = item.contentDetails?.boundStreamId;
      const scheduledStartStr = item.snippet?.scheduledStartTime;

      if (!boundStreamId || !scheduledStartStr) continue;

      if (boundStreamId === streamId) {
        const scheduledStart = DateTime.fromISO(scheduledStartStr).setZone("America/Los_Angeles");
        const existingWindow = Interval.fromDateTimes(
          scheduledStart,
          scheduledStart.plus({ minutes: CONFLICT_WINDOW_MINUTES })
        );
        const newWindow = Interval.fromDateTimes(
          newStartTime,
          newStartTime.plus({ minutes: CONFLICT_WINDOW_MINUTES })
        );

        if (existingWindow.overlaps(newWindow)) {
          console.error(`  Conflict with existing livestream:`);
          console.error(`- Title: ${item.snippet.title}`);
          console.error(`- Broadcast ID: ${item.id}`);
          console.error(`- Scheduled Start Time: ${scheduledStart.toFormat("yyyy-MM-dd HH:mm")} PST`);
          console.error(`- Bound Stream ID: ${boundStreamId}`);
          return true;
        }
      }
    }
  } catch (error) {
    console.error("Error fetching live broadcasts:", error.message);

    // 🔍 Log the full error object for debugging
    console.error("Full error object:", JSON.stringify(error, null, 2));

    if (error.errors) {
      error.errors.forEach((err) => {
        console.error(`- Reason: ${err.reason}`);
        console.error(`- Message: ${err.message}`);
      });
    }

    throw error; // Re-throw the error after logging
  }

  return false;
}

async function verifyConfiguredStreamIds(auth) {
  const youtube = google.youtube({ version: "v3", auth });

  // Only check each unique stream ID once.
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

      const item = res.data.items?.[0];

      if (!item) {
        console.error(`❌ ${stream.name} stream does not exist.`);
        console.error(`- Configured Stream ID: ${stream.streamId}`);
        allValid = false;
        continue;
      }

      // Extra safety: verify this stream belongs to church channel
      if (item.snippet?.channelId !== CHURCH_CHANNEL_ID) {
        console.error(`❌ ${stream.name} stream belongs to the wrong channel.`);
        console.error(`- Stream ID: ${stream.streamId}`);
        console.error(`- Stream Channel ID: ${item.snippet?.channelId}`);
        console.error(`- Expected Channel ID: ${CHURCH_CHANNEL_ID}`);
        allValid = false;
        continue;
      }

      console.log(`✅ ${stream.name} stream verified.`);
      console.log(`- Title: ${item.snippet?.title || "Unknown"}`);
      console.log(`- Stream ID: ${item.id}`);
      console.log(`- Status: ${item.status?.streamStatus || "Unknown"}`);
      console.log(`- Reusable: ${item.contentDetails?.isReusable ?? "Unknown"}`);
    } catch (err) {
      handleOAuthError(err);
      console.error(`❌ Could not verify ${stream.name} stream.`);
      console.error(`- Stream ID: ${stream.streamId}`);
      console.error(`- Error: ${err.message}`);
      allValid = false;
    }
  }

  if (!allValid) {
    console.error(
      "❌ PRECHECK FAILED: One or more configured YouTube Stream IDs are invalid."
    );
    console.error(
      "❌ No livestream broadcasts will be created."
    );
    return false;
  }

  console.log("✅ All configured YouTube Stream IDs passed preflight check.");
  console.log("-------------------------------------------");

  return true;
}

async function scheduleLivestream(auth, titlePrefix, hour, minute, streamId) {
  const youtube = google.youtube({ version: "v3", auth });
  const sunday = getNextSundayDateTime(hour, minute);

  if (await hasConflictingBroadcast(auth, streamId, sunday)) {
    throw new Error("Conflicting scheduled livestream using the same stream ID.");
  }

  const formattedDate = sunday.toFormat("M/d/yy");
  const title = `${formattedDate} ${titlePrefix}`;
  const description = titlePrefix.includes("English")
    ? `We hope to connect with you! Send us an email.\ninfo@cec-sd.org\n\nFor more info, please check out our website.\nhttps://cec-sd.org`
    : title;

  // Create the broadcast
  const broadcastRes = await youtube.liveBroadcasts.insert({
    part: "snippet,contentDetails,status",
    requestBody: {
      snippet: { title, description, scheduledStartTime: sunday.toISO() },
      status: { privacyStatus: "public" },
      contentDetails: {
        monitorStream: { enableMonitorStream: false },
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

  const broadcastId = broadcastRes.data.id;

  // Update video metadata
  await youtube.videos.update({
    part: "snippet",
    requestBody: { id: broadcastId, snippet: { title, description, categoryId: "29" } },
  });

  // Bind the stream
  let bindRes;
  try {
    bindRes = await youtube.liveBroadcasts.bind({
      id: broadcastId,
      part: "id,contentDetails",
      streamId,
    });
  } catch (err) {
    handleOAuthError(err);
    console.error(`❌ Failed to bind stream for: ${titlePrefix} — ${err.message}`);
    
    // 🧹 Clean up the created broadcast
    try {
      await youtube.liveBroadcasts.delete({ id: broadcastId });
      console.log(`🗑️ Deleted broadcast: ${broadcastId} due to failed bind.`);
    } catch (deleteErr) {
      console.error(`⚠️ Failed to delete broadcast: ${broadcastId}`, deleteErr.message);
    }
    throw new Error(`Failed to bind stream for: ${titlePrefix} — ${err.message}`);
  }

  if (!bindRes || !bindRes.data || !bindRes.data.contentDetails?.boundStreamId) {
    throw new Error(`Bind response missing boundStreamId for: ${titlePrefix}`);
  }

  const boundStreamId = bindRes.data.contentDetails.boundStreamId;

  // 🔎 Fetch ingestion stream key
  let ingestionKey = "Unavailable";
  try {
    const streamRes = await youtube.liveStreams.list({
      part: "cdn",
      id: boundStreamId,
    });

    if (streamRes.data.items?.length) {
      ingestionKey = streamRes.data.items[0].cdn.ingestionInfo.streamName;
    }
  } catch (err) {
    console.error("  Could not retrieve ingestion stream key:", err.message);
  }

  const youtubeLink = `https://www.youtube.com/watch?v=${broadcastId}`;

  console.log(`✅ Scheduled livestream: ${title}`);
  console.log(`- Broadcast ID: ${broadcastId}`);
  console.log(`- Scheduled Start Time: ${sunday.toFormat("yyyy-MM-dd HH:mm")} PST`);
  console.log(`- Requested Stream ID: ${streamId}`);
  console.log(`- Bound Stream ID: ${boundStreamId}`);
  console.log(`- Ingestion Stream Key: ${ingestionKey}`);
  console.log(`- YouTube Link: ${youtubeLink}`);
  console.log("--------------------------------------------------");

  return { success: true, title, youtubeLink };
}


async function sendEmail(successes, failures) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: config.EMAIL_SENDER,
      pass: config.EMAIL_PASSWORD,
    },
  });

  let emailBody = `Here are the results for the scheduled YouTube livestreams for this Sunday:\n\n`;

  if (successes.length) {
    emailBody += `✅ Successes:\n`;
    emailBody += successes.map(s => `- ${s.title}\n  ${s.youtubeLink}`).join("\n\n") + "\n\n";
  } else {
    emailBody += `✅ Successes: None\n\n`;
  }

  if (failures.length) {
    emailBody += `❌ Failures:\n`;
    emailBody += failures.map(f => `- ${f.title}\n  Error: ${f.error}`).join("\n\n") + "\n\n";
  } else {
    emailBody += `❌ Failures: None\n\n`;
  }

  if (errorLogs.length > 0) {
    emailBody += `🪵 Error Logs:\n`;
    emailBody += errorLogs.map(log => `- ${log}`).join("\n") + "\n";
  }

  const nextSunday = DateTime.now().setZone("America/Los_Angeles").plus({ days: (7 - DateTime.now().weekday) % 7 || 7 });
  const formattedNextSunday = nextSunday.toFormat("M/d/yy");

  try {
    await transporter.sendMail({
      from: config.EMAIL_SENDER,
      to: config.EMAIL_RECIPIENTS.join(", "),
        subject: `CEC YouTube Livestream Scheduling Summary For This Sunday (${formattedNextSunday})`,
      text: emailBody,
    });

    console.log(`✅ Email sent to: ${config.EMAIL_RECIPIENTS.join(", ")}`);
    return true;

  } catch (err) {
    console.error(`❌ Failed to send summary email: ${err.message}`);

    if (err.code === "EAUTH") {
      console.error(
        "❌ Gmail authentication failed. Check EMAIL_SENDER and regenerate the Gmail App Password."
      );
    }

    return false;
  }

}

(async () => {
  try {
    const auth = await authorize();

    if (!(await verifyYouTubeAuth(auth))) {
      console.error("❌ Aborting: YouTube auth is invalid or misconfigured.");

      await sendEmail([], [{
        title: "Preflight Authentication Check",
        error: "YouTube authentication is invalid or misconfigured."
      }]);

      process.exit(1);
    }

    if (!(await verifyChannel(auth))) {
      await sendEmail([], [{
        title: "Preflight Channel Check",
        error: "Authenticated YouTube channel does not match the expected church channel."
      }]);

      process.exit(1);
    }

    // =========================================================
    // PRECHECK: Verify configured persistent Stream IDs exist
    // BEFORE creating any broadcast
    // =========================================================
    if (!(await verifyConfiguredStreamIds(auth))) {
      await sendEmail([], [{
        title: "Preflight Stream ID Check",
        error:
          "One or more configured YouTube Stream IDs no longer exist or belong to the wrong channel. No broadcasts were created."
      }]);

      process.exit(1);
    }


    const streams = [
      { title: "English Sunday Worship", hour: 9, minute: 15, streamId: PERSISTENT_STREAM_ID_SANCTUARY },
      { title: "Mandarin Sunday Worship 國語主日崇拜", hour: 9, minute: 15, streamId: PERSISTENT_STREAM_ID_FELLOWSHIP },
      { title: "Cantonese Sunday Worship 粵語主日崇拜", hour: 11, minute: 0, streamId: PERSISTENT_STREAM_ID_SANCTUARY },
    ];

    const successes = [];
    const failures = [];

    for (const s of streams) {
      try {
        const result = await scheduleLivestream(auth, s.title, s.hour, s.minute, s.streamId);
        successes.push(result);
      } catch (err) {
        console.error(`❌ Failed to schedule: ${s.title}`, err.message);
        failures.push({ title: s.title, error: err.message });
      }
    }

    await sendEmail(successes, failures);
    console.log(`\nScript completed. ${successes.length} success(es), ${failures.length} failure(s).`);
  } catch (error) {
    console.error("❌ Error:", error);
    await sendEmail([], [{ title: "Top-level error", error: error.message }]);
    process.exit(1);
  }
})();

