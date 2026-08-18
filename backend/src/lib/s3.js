import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});
const BUCKET = () => process.env.BUCKET_NAME;

export const sourceKey = (userId, materialId, fileName) =>
  `uploads/${userId}/${materialId}/${fileName.replace(/[^\w.\-]+/g, '_')}`;

export const audioKey = (userId, materialId) => `audio/${userId}/${materialId}.mp3`;

/**
 * The browser PUTs the file directly to S3 with this URL, so the file never
 * passes through Lambda. That keeps a 25 MB deck off the request path and out
 * of the 6 MB API Gateway payload limit entirely.
 *
 * Five minutes is deliberately short: long enough for a slow upload on campus
 * wifi, short enough that a leaked URL is not a standing write grant.
 */
export function presignUpload(key, contentType) {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET(), Key: key, ContentType: contentType || 'application/octet-stream' }),
    { expiresIn: 300 },
  );
}

export function presignDownload(key, expiresIn = 900) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET(), Key: key }), { expiresIn });
}

export async function getObjectBytes(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

export async function putObject(key, body, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET(), Key: key, Body: body, ContentType: contentType }));
  return key;
}

export async function deleteObject(key) {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
  } catch (e) {
    // A missing source file must not block deleting the recap that references
    // it — the lifecycle rule may already have expired the object.
    console.warn('Could not delete S3 object', key, e?.name);
  }
}
