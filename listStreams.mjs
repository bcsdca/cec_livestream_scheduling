// listStreams.mjs
import { google } from "googleapis";
import { authorize } from "./auth.mjs";

async function listStreams(auth) {
  const youtube = google.youtube({ version: "v3", auth });

  const res = await youtube.liveStreams.list({
    part: "snippet,cdn,status",
    mine: true,
    maxResults: 50,
  });

  for (const item of res.data.items || []) {
    console.log("Title:", item.snippet.title);
    console.log("Stream ID:", item.id);
    console.log("Stream Key:", item.cdn.ingestionInfo.streamName);
    console.log("--------------------------------------------------");
  }
}

// main runner
(async () => {
  try {
    const auth = await authorize();   // ← this creates auth
    await listStreams(auth);
  } catch (err) {
    console.error("Error:", err);
  }
})();

