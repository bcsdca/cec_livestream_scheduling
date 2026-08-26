import { google } from "googleapis";
import { authorize } from "./auth.mjs";

async function main() {
  const auth = await authorize();

  const youtube = google.youtube({
    version: "v3",
    auth,
  });

  const res = await youtube.liveStreams.list({
    part: "id,snippet,cdn,status,contentDetails",
    mine: true,
    maxResults: 50,
  });

  const streams = res.data.items || [];

  if (streams.length === 0) {
    console.log("❌ No reusable live streams found.");
    return;
  }

  console.log(`\nFound ${streams.length} live stream(s):\n`);

  for (const stream of streams) {
    console.log("--------------------------------------------------");
    console.log(`Title:       ${stream.snippet?.title || "Unknown"}`);
    console.log(`Stream ID:   ${stream.id}`);
    console.log(`Status:      ${stream.status?.streamStatus || "Unknown"}`);
    console.log(`Reusable:    ${stream.contentDetails?.isReusable}`);

    const ingestionKey =
      stream.cdn?.ingestionInfo?.streamName || "Unavailable";

    console.log(`Stream Key:  ${ingestionKey}`);
  }

  console.log("--------------------------------------------------");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
