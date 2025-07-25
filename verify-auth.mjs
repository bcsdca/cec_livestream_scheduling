// verify-auth.mjs
import { google } from "googleapis";

export async function verifyYouTubeAuth(auth) {
  try {
    await auth.getAccessToken(); // Triggers refresh if needed
    const youtube = google.youtube({ version: "v3", auth });

    await youtube.liveBroadcasts.list({
      part: "id",
      maxResults: 1,
      mine: true, // Required to avoid "No filter selected" error
    });

    return true;
  } catch (err) {
    console.error("❌ YouTube API authorization check failed:", err.message);
    return false;
  }
}

