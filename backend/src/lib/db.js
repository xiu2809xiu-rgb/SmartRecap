import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'node:crypto';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = () => process.env.TABLE_NAME;

/* --------------------------------------------------------------- key shapes */

export const keys = {
  user: (userId) => ({ pk: `USER#${userId}`, sk: 'PROFILE' }),
  material: (userId, materialId) => ({ pk: `USER#${userId}`, sk: `MATERIAL#${materialId}` }),
  materialPrefix: (userId) => ({ pk: `USER#${userId}`, prefix: 'MATERIAL#' }),
  attempt: (userId, at, attemptId) => ({ pk: `USER#${userId}`, sk: `ATTEMPT#${at}#${attemptId}` }),
  attemptPrefix: (userId) => ({ pk: `USER#${userId}`, prefix: 'ATTEMPT#' }),
  cards: (userId, materialId) => ({ pk: `USER#${userId}`, sk: `CARDS#${materialId}` }),
  job: (jobId) => ({ pk: `JOB#${jobId}`, sk: 'JOB' }),
  share: (token) => ({ pk: `SHARE#${token}`, sk: 'SHARE' }),
  emailIndex: (email) => ({ pk: `EMAIL#${email.toLowerCase()}`, sk: 'INDEX' }),
};

export const newId = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`;

/** Seconds-since-epoch TTL value `n` days out, for DynamoDB's TTL attribute. */
export const ttlDays = (n) => Math.floor(Date.now() / 1000) + n * 86_400;

/* ------------------------------------------------------------------ access */

export async function getItem(key) {
  const { Item } = await client.send(new GetCommand({ TableName: TABLE(), Key: key }));
  return Item ?? null;
}

export async function putItem(item, { ifNotExists = false } = {}) {
  await client.send(
    new PutCommand({
      TableName: TABLE(),
      Item: item,
      ...(ifNotExists ? { ConditionExpression: 'attribute_not_exists(pk)' } : null),
    }),
  );
  return item;
}

export async function deleteItem(key) {
  await client.send(new DeleteCommand({ TableName: TABLE(), Key: key }));
}

export async function updateItem(key, patch) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return null;

  const names = {};
  const values = {};
  const sets = entries.map(([k, v], i) => {
    names[`#k${i}`] = k;
    values[`:v${i}`] = v;
    return `#k${i} = :v${i}`;
  });

  const { Attributes } = await client.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: key,
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return Attributes;
}

/**
 * Every list this app shows is one partition filtered by an sk prefix, so a
 * single Query covers it. Paginates because a heavy user's material list can
 * exceed DynamoDB's 1 MB page — recaps are stored inline and are not small.
 */
export async function queryPrefix({ pk, prefix }, { limit, scanForward = false } = {}) {
  const items = [];
  let ExclusiveStartKey;

  do {
    const page = await client.send(
      new QueryCommand({
        TableName: TABLE(),
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
        ScanIndexForward: scanForward,
        ExclusiveStartKey,
        ...(limit ? { Limit: limit } : null),
      }),
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey && (!limit || items.length < limit));

  return limit ? items.slice(0, limit) : items;
}
