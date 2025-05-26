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

// === Utility ===
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

  await youtube.liveBroadcasts.bind({
    id: broadcastId,
    part: "id,contentDetails",
    streamId,
  });

  const youtubeLink = `https://www.youtube.com/watch?v=${broadcastId}`;

  console.log(`✅ Scheduled livestream: ${title}`);
  console.log(`- Broadcast ID: ${broadcastId}`);
  console.log(`- Scheduled Time: ${sunday.toFormat("yyyy-MM-dd HH:mm")} PST`);
  console.log(`- Bound Stream ID: ${streamId}`);
  console.log(`- YouTube Link: ${youtubeLink}`);
  console.log("--------------------------------------------------");

  return { title, youtubeLink };
}

async function sendEmail(links) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'shui.bill.chu@gmail.com', // Replace with your Gmail
      pass: 'tcmmgtogvtduznmt',        // Your generated App Password
    },
  });

  const emailBody = links.map(l => `${l.title}\n${l.youtubeLink}`).join('\n\n');

  await transporter.sendMail({
    from: 'shui.bill.chu@gmail.com', // Replace with your Gmail
    to: 'shui.bill.chu@gmail.com, coutlechu@gmail.com', // Multiple recipients separated by comma
    subject: 'Scheduled CEC YouTube Livestreams',
    text: `Here are the scheduled YouTube livestreams for this Sunday:\n\n${emailBody}`,
  });

  console.log("✅ Email sent to shui.bill.chu@gmail.com and coutlechu@gmail.com");
}


// === Main Script ===
(async () => {
  try {
    const auth = await authorize();
    const verified = await verifyChannel(auth);
    if (!verified) process.exit(1);

    const tasks = [
      scheduleLivestream(auth, "English Sunday Worship", 9, 30, PERSISTENT_STREAM_ID_SANCTUARY),
      scheduleLivestream(auth, "Mandarin Sunday Worship 國語主日崇拜", 9, 30, PERSISTENT_STREAM_ID_FELLOWSHIP),
      scheduleLivestream(auth, "Cantonese Sunday Worship 粵語主日崇拜", 11, 0, PERSISTENT_STREAM_ID_SANCTUARY),
    ];

    const results = await Promise.all(tasks);
    await sendEmail(results);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
})();

