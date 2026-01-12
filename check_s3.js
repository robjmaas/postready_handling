import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const s3Client = new S3Client({ region: "us-east-1" });

async function checkS3() {
  try {
    console.log("Checking S3 outputs folder...");
    const command = new ListObjectsV2Command({
      Bucket: "postready-staging",
      Prefix: "outputs/"
    });
    
    const result = await s3Client.send(command);
    
    console.log(`Found ${result.Contents?.length || 0} files in outputs/:`);
    if (result.Contents) {
      result.Contents.forEach(obj => {
        const sizeInMB = (obj.Size / 1024 / 1024).toFixed(2);
        console.log(`  - ${obj.Key} (${sizeInMB} MB, modified: ${obj.LastModified})`);
      });
    } else {
      console.log("  (folder is empty or does not exist)");
    }
    
    process.exit(0);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

checkS3();
