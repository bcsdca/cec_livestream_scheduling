// schedule-all-streams.mjs
import fs from "fs";
import { google } from "googleapis";
import readline from "readline";
import open from "open";
import nodemailer from "nodemailer";
import { DateTime } from "luxon";
import { config } from './config.mjs';

const {
  PERSISTENT_STREAM_ID_SANCTUARY,
  PERSISTENT_STREAM_ID_FELLOWSHIP,
  CHURCH_CHANNEL_ID,
} = config;

const CREDENTIALS_PATH = "credentials.json";
const TOKEN_PATH = "token.json";
const SCOPES = ["https://www.googleapis.com/auth/youtube"];

const runTime = DateTime.now().setZone("America/Los_Angeles").toFormat("yyyy-MM-dd HH:mm:ss");
console.log(`\n=== Script run at: ${runTime} PST ===`);

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
    return oAuth2Client;
  }

  const authUrl = oAuth2Client.generateAuthUrl({ access_type: "offline", scope: SCOPES });
  console.log("Authorize this app by visiting:", authUrl);
  await open(authUrl);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("Enter the code from the page: ", (code) => {
      rl.close();
      oAuth2Client.getToken(code, (err, token) => {
        if (err) return console.error("Error retrieving access token", err);
        oAuth2Client.setCredentials(token);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
        resolve(oAuth2Client);
      });
    });
  });
}

async function verifyChannel(auth) {
  const youtube = google.youtube({ version: "v3", auth });
  const res = await youtube.channels.list({
    part: "id,snippet",
    mine: true,
  });

  const channel = res.data.items?.[0];
  if (!channel) {
    console.error("❌ No channel found for this account.");
    return false;
  }

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

async function scheduleLivestream(auth, titlePrefix, hour, minute, streamId) {
  const youtube = google.youtube({ version: "v3", auth });

  if (!streamId) {
    throw new Error(`Missing streamId for: ${titlePrefix}`);
  }

  const sunday = getNextSundayDateTime(hour, minute);
  const formattedDate = sunday.toFormat("M/d/yy");

  const title = `${formattedDate} ${titlePrefix}`;
  const description =
    titlePrefix.includes("English")
      ? `We hope to connect with you! Send us an email.\ninfo@cec-sd.org\n\nFor more info, please check out our website.\nhttps://cec-sd.org`
      : title;

  const broadcastRes = await youtube.liveBroadcasts.insert({
    part: "snippet,contentDetails,status",
    requestBody: {
      snippet: {
        title,
        description,
        scheduledStartTime: sunday.toISO(),
      },
      status: {
        privacyStatus: "public",
      },
      contentDetails: {
        monitorStream: { enableMonitorStream: false },
      },
    },
  });

  const broadcastId = broadcastRes.data.id;

  await youtube.videos.update({
    part: "snippet",
    requestBody: {
      id: broadcastId,
      snippet: {
        title,
        description,
        categoryId: "29", // Nonprofits & Activism
      },
    },
  });

  const bindRes = await youtube.liveBroadcasts.bind({
    id: broadcastId,
    part: "id,contentDetails",
    streamId,
  });

  const boundStreamId = bindRes.data.contentDetails?.boundStreamId;
  if (!boundStreamId) {
    throw new Error(`Failed to bind stream for: ${titlePrefix}`);
  }

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
    service: 'gmail',
    auth: {
      user: 'shui.bill.chu@gmail.com',
      pass: 'tcmmgtogvtduznmt', // App password
    },
  });

  let emailBody = `Here are the results for the scheduled YouTube livestreams for this Sunday:\n\n`;

  if (successes.length) {
    emailBody += `✅ Successes:\n`;
    emailBody += successes.map(s => `- ${s.title}\n  ${s.youtubeLink}`).join('\n\n');
    emailBody += '\n\n';
  } else {
    emailBody += `✅ Successes: None\n\n`;
  }

  if (failures.length) {
    emailBody += `❌ Failures:\n`;
    emailBody += failures.map(f => `- ${f.title}\n  Error: ${f.error}`).join('\n\n');
  } else {
    emailBody += `❌ Failures: None`;
  }

  const recipientList = [
    'shui.bill.chu@gmail.com',
    'jasontong818@gmail.com',
    'michael.s.kuo@gmail.com',
  ];

  //const recipientList = [
  //  'shui.bill.chu@gmail.com',
  //  'coutlechu@gmail.com',
  //];

  await transporter.sendMail({
    from: 'shui.bill.chu@gmail.com',
    to: recipientList.join(', '), 
    subject: 'CEC YouTube Livestream Scheduling Summary',
    text: emailBody,
  });

  console.log(`✅ Email sent to: ${recipientList.join(', ')}`);
}

// === Main Script ===
(async () => {
  try {
    const auth = await authorize();
    const verified = await verifyChannel(auth);
    if (!verified) process.exit(1);

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
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
})();

