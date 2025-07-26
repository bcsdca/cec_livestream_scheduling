// auth.mjs
//400	Bad Request	Invalid parameters, missing fields
//401	Unauthorized	Access token is missing/expired
//403	Forbidden	Token valid, but lacks scope or quota
//404	Not Found	Broadcast/stream ID doesn’t exist
//409	Conflict	Broadcast time overlaps with another
//429	Too Many Requests	Quota exceeded
//500	Internal Server Error	YouTube server-side issue

import fs from "fs";
import { google } from "googleapis";
import readline from "readline";
import open from "open";

const CREDENTIALS_PATH = "credentials.json";
const TOKEN_PATH = "token.json";
const SCOPES = ["https://www.googleapis.com/auth/youtube"];

export async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));

    if (!token.refresh_token) {
      console.error("❌ Missing refresh_token in token.json. Please delete it and reauthorize.");
      process.exit(1);
    }

    oAuth2Client.setCredentials(token);

    oAuth2Client.on("tokens", (tokens) => {
      const merged = tokens.refresh_token
        ? { ...oAuth2Client.credentials, refresh_token: tokens.refresh_token }
        : oAuth2Client.credentials;

      fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
    });

    // 🧪 Try fetching access token to validate
    try {
      await oAuth2Client.getAccessToken(); // refreshes token if needed
    } catch (err) {
      handleOAuthError(err);
      process.exit(1);
    }

    return oAuth2Client;
  }

  // Begin first-time auth
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });

  console.log("Authorize this app by visiting:", authUrl);
  await open(authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("Enter the code from the page: ", (code) => {
      rl.close();
      oAuth2Client.getToken(code, (err, token) => {
        if (err || !token) {
          console.error("❌ Error retrieving access token:", err?.message || "Unknown error");
          handleOAuthError(err);
          process.exit(1);
        }

        if (!token.refresh_token) {
          console.error("❌ Token does not include a refresh_token.");
          console.error("Try deleting token.json and authorizing again.");
          process.exit(1);
        }

        oAuth2Client.setCredentials(token);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
        resolve(oAuth2Client);
      });
    });
  });
}

export function handleOAuthError(error) {
  const status = error?.response?.status;
  const message = error?.message || "Unknown error";

  console.error(`❌ OAuth Error (${status || "No status"}): ${message}`);

  switch (status) {
    case 400:
      console.error("🔎 400 - Bad Request: Check if parameters or fields are missing.");
      break;
    case 401:
      console.error("🔐 401 - Unauthorized: Access token is missing or expired.");
      break;
    case 403:
      console.error("🚫 403 - Forbidden: Token is valid but lacks required scope or quota.");
      break;
    case 404:
      console.error("❓ 404 - Not Found: Resource like broadcast or stream ID may not exist.");
      break;
    case 409:
      console.error("⚠️ 409 - Conflict: Broadcast time may overlap with another.");
      break;
    case 429:
      console.error("⏳ 429 - Too Many Requests: You've hit a quota or rate limit.");
      break;
    case 500:
      console.error("💥 500 - Internal Server Error: YouTube server issue, try again later.");
      break;
    default:
      console.error("❗ An unexpected error occurred.");
      if (!status) {
        console.error("Likely network or unknown error:", error);
      }
  }
  // Optionally return false for unrecoverable errors, true for recoverable, etc.
  return status !== 401 && status !== 403;
}


