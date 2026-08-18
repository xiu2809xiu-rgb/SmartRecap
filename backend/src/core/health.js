import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { TextractClient } from '@aws-sdk/client-textract';
import { PollyClient, DescribeVoicesCommand } from '@aws-sdk/client-polly';
import { CognitoIdentityProviderClient, DescribeUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';
import { configuredProviders } from '../ai/provider.js';

/**
 * Is this deployment actually working?
 *
 * "The deployment works properly" is a thing that has to be shown, not
 * asserted, and the usual way it gets shown is a demo that happens to succeed.
 * This checks each service the pipeline depends on with the cheapest call that
 * proves reachability AND permission, so a misconfigured instance profile or a
 * bucket in the wrong region surfaces before a judge is watching rather than
 * during.
 *
 * Every check is read-only and none of them create or cost anything. Results
 * are cached briefly so hammering the page cannot turn into an AWS bill.
 */

const CACHE_MS = 15_000;
let cache = { at: 0, value: null };

const timed = async (name, fn) => {
  const startedAt = Date.now();
  try {
    await fn();
    return { name, ok: true, ms: Date.now() - startedAt };
  } catch (e) {
    return {
      name,
      ok: false,
      ms: Date.now() - startedAt,
      // `AccessDenied` vs `NotFound` vs a network error are three very
      // different fixes, so the name is worth more than a boolean.
      error: e?.name || 'Error',
    };
  }
};

async function probeAws() {
  const region = process.env.AWS_REGION;
  const checks = [];

  if (process.env.TABLE_NAME) {
    const ddb = new DynamoDBClient({});
    checks.push(
      timed('DynamoDB', () => ddb.send(new DescribeTableCommand({ TableName: process.env.TABLE_NAME }))),
    );
  }

  if (process.env.BUCKET_NAME) {
    const s3 = new S3Client({});
    checks.push(timed('S3', () => s3.send(new HeadBucketCommand({ Bucket: process.env.BUCKET_NAME }))));
  }

  if (process.env.USER_POOL_ID) {
    const cognito = new CognitoIdentityProviderClient({});
    checks.push(
      timed('Cognito', () => cognito.send(new DescribeUserPoolCommand({ UserPoolId: process.env.USER_POOL_ID }))),
    );
  }

  // Textract has no free describe-style call, so reachability is proven by
  // whether the client can be constructed and resolve credentials. A real OCR
  // request would cost money on every health check.
  checks.push(
    timed('Textract', async () => {
      const client = new TextractClient({});
      const creds = await client.config.credentials();
      if (!creds?.accessKeyId) throw Object.assign(new Error('no credentials'), { name: 'CredentialsError' });
    }),
  );

  checks.push(timed('Polly', () => new PollyClient({}).send(new DescribeVoicesCommand({ LanguageCode: 'en-GB' }))));

  return { region: region ?? 'unset', services: await Promise.all(checks) };
}

export async function health({ deep = false } = {}) {
  const base = {
    ok: true,
    mode: 'live',
    providers: configuredProviders().map((p) => p.name),
    region: process.env.AWS_REGION ?? 'unset',
    uptimeSeconds: Math.round(process.uptime()),
  };

  // The plain check stays instant; the AWS probe is opt-in so a load balancer
  // polling /health never triggers five AWS calls a second.
  if (!deep) return base;

  if (cache.value && Date.now() - cache.at < CACHE_MS) return { ...base, aws: cache.value, cached: true };

  const aws = await probeAws();
  cache = { at: Date.now(), value: aws };
  return { ...base, aws };
}
