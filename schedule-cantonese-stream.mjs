import fs from "fs";
import { google } from "googleapis";
import readline from "readline";
import open from "open";
import { DateTime } from "luxon";

const CREDENTIALS_PATH = "credentials.json";
const TOKEN_PATH = "token.json";
const SCOPES = ["https://www.googleapis.com/auth/youtube"];

import { config } from './config.mjs';
const { PERSISTENT_STREAM_ID_SANCTUARY } = config;

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

function getNextSundayDateTime() {
  const now = DateTime.now().setZone("America/Los_Angeles");
  const nextSunday = now.plus({ days: (7 - now.weekday) % 7 || 7 }).set({
    hour: 11,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  return nextSunday;
}

async function createScheduledStream(auth) {
  const youtube = google.youtube({ version: "v3", auth });
  const sunday = getNextSundayDateTime();
  const formattedDate = sunday.toFormat("M/d/yy");

  const title = `${formattedDate} 粵語主日崇拜 Cantonese Sunday Worship`;
  const description = title;

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

  // Bind to persistent stream
  await youtube.liveBroadcasts.bind({
    id: broadcastId,
    part: "id,contentDetails",
    streamId: PERSISTENT_STREAM_ID_SANCTUARY,
  });

  console.log("✅ Scheduled Cantonese livestream:");
  console.log(`- Title: ${title}`);
  console.log(`- Broadcast ID: ${broadcastId}`);
  console.log(`- Scheduled Time: ${sunday.toFormat("yyyy-MM-dd HH:mm")} PST`);
  console.log(`- Bound Stream ID: ${PERSISTENT_STREAM_ID_SANCTUARY}`);
}

authorize().then(createScheduledStream).catch(console.error);

