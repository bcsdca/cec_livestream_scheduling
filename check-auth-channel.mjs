import fs from "fs";
import { google } from "googleapis";
import readline from "readline";
import open from "open";

const CREDENTIALS_PATH = "credentials.json";
const TOKEN_PATH = "token.json";
const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
    return oAuth2Client;
  }

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
  console.log("🔐 Authorize this app by visiting this URL:\n", authUrl);
  await open(authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("Enter the code from the page: ", (code) => {
      rl.close();
      oAuth2Client.getToken(code, (err, token) => {
        if (err) return console.error("❌ Error retrieving access token", err);
        oAuth2Client.setCredentials(token);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
        console.log("✅ Token saved to", TOKEN_PATH);
        resolve(oAuth2Client);
      });
    });
  });
}

async function checkChannel(auth) {
  const youtube = google.youtube({ version: "v3", auth });

  const res = await youtube.channels.list({
    part: "snippet",
    mine: true,
  });

  const channel = res.data.items?.[0];
  if (!channel) {
    console.error("❌ No channel found for this account.");
    return;
  }

  console.log("🎯 Authenticated to channel:");
  console.log(`- Name: ${channel.snippet.title}`);
  console.log(`- Channel ID: ${channel.id}`);
  console.log(`- Description: ${channel.snippet.description || "(No description)"}`);
}

authorize()
  .then(checkChannel)
  .catch(console.error);

