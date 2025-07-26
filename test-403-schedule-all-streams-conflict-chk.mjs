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

const CONFLICT_WINDOW_MINUTES = 90;

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
          console.error(`- Scheduled Time: ${scheduledStart.toFormat("yyyy-MM-dd HH:mm")} PST`);
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

  const youtubeLink = `https://www.youtube.com/watch?v=${broadcastId}`;
  console.log(`✅ Scheduled livestream: ${title}`);
  console.log(`- Broadcast ID: ${broadcastId}`);
  console.log(`- Scheduled Time: ${sunday.toFormat("yyyy-MM-dd HH:mm")} PST`);
  console.log(`- Bound Stream ID: ${boundStreamId}`);
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

  await transporter.sendMail({
    from: config.EMAIL_SENDER,
    to: config.EMAIL_RECIPIENTS.join(", "),
    subject: `CEC YouTube Livestream Scheduling Summary For This Sunday (${formattedNextSunday})`,
    text: emailBody,
  });

  console.log(`✅ Email sent to: ${config.EMAIL_RECIPIENTS.join(", ")}`);
}

(async () => {
  try {
    const auth = await authorize();

    if (!(await verifyYouTubeAuth(auth))) {
      console.error("❌ Aborting: YouTube auth is invalid or misconfigured.");
      process.exit(1);
    }

    if (!(await verifyChannel(auth))) process.exit(1);

    const streams = [
      { title: "English Sunday Worship-Test 403 Forbidden", hour: 9, minute: 15, streamId: "UCZFmzvtF_0ffm0YNxV3o9QQ" },
      { title: "Mandarin Sunday Worship 國語主日崇拜-Test 403 Forbidden", hour: 9, minute: 15, streamId: "UCZFmzvtF_0ffm0YNxV3o9QQ" },
      { title: "Cantonese Sunday Worship 粵語主日崇拜-Test 403 Forbidden", hour: 11, minute: 0, streamId: "UCZFmzvtF_0ffm0YNxV3o9QQ" },
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

