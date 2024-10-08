let express = require('express');
let sqlite3 = require('better-sqlite3');
let bodyParser = require('body-parser');
let cors = require('cors');
let { Timestamp } = require('./client/shared/timestamp');
let merkle = require('./client/shared/merkle');

let db = sqlite3(__dirname + '/db.sqlite');
db.exec(
  `create table if not exists messages
   (
       timestamp TEXT,
       group_id  TEXT,
       dataset   TEXT,
       row       TEXT,
       column    TEXT,
       value     TEXT,
       PRIMARY KEY (timestamp, group_id)
   );

  CREATE TABLE if not exists messages_merkles
  (
      group_id TEXT PRIMARY KEY,
      merkle   TEXT
  );`,
);

let app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '20mb' }));

function queryAll(sql, params = []) {
  let stmt = db.prepare(sql);
  return stmt.all(...params);
}

function queryRun(sql, params = []) {
  let stmt = db.prepare(sql);
  return stmt.run(...params);
}

function serializeValue(value) {
  if (value === null) {
    return '0:';
  } else if (typeof value === 'number') {
    return 'N:' + value;
  } else if (typeof value === 'string') {
    return 'S:' + value;
  }

  throw new Error('Unserializable value type: ' + JSON.stringify(value));
}

function deserializeValue(value) {
  const type = value[0];
  switch (type) {
    case '0':
      return null;
    case 'N':
      return parseFloat(value.slice(2));
    case 'S':
      return value.slice(2);
  }

  throw new Error('Invalid type key for value: ' + value);
}

function getMerkle(group_id) {
  let rows = queryAll('SELECT * FROM messages_merkles WHERE group_id = ?', [
    group_id,
  ]);

  if (rows.length > 0) {
    return JSON.parse(rows[0].merkle);
  } else {
    // No merkle trie exists yet (first sync of the app), so create a
    // default one.
    return {};
  }
}

function addMessages(groupId, messages) {
  let trie = getMerkle(groupId);

  queryRun('BEGIN');

  try {
    for (let message of messages) {
      const { dataset, row, column, value, timestamp } = message;

      let res = queryRun(
        `INSERT OR IGNORE INTO messages (timestamp, group_id, dataset, row, column, value)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [timestamp, groupId, dataset, row, column, serializeValue(value)],
      );

      if (res.changes === 1) {
        // Update the merkle trie
        trie = merkle.insert(trie, Timestamp.parse(message.timestamp));
      }
    }

    queryRun(
      'INSERT OR REPLACE INTO messages_merkles (group_id, merkle) VALUES (?, ?)',
      [groupId, JSON.stringify(trie)],
    );
    queryRun('COMMIT');
  } catch (e) {
    queryRun('ROLLBACK');
    throw e;
  }

  return trie;
}

app.post('/sync', (req, res) => {
  let { group_id, client_id, messages, merkle: clientMerkle } = req.body;

  let trie = addMessages(group_id, messages);

  let newMessages = [];
  if (clientMerkle) {
    // Get the point in time (in minutes?) at which the two collections of
    // messages "forked." In other words, at this point in time, something
    // changed (e.g., one collection inserted a message that the other lacks)
    // which resulted in differing hashes.
    let diffTime = merkle.diff(trie, clientMerkle);
    if (diffTime) {
      let timestamp = new Timestamp(diffTime, 0, '0').toString();
      newMessages = queryAll(
        `SELECT *
         FROM messages
         WHERE group_id = ?
           AND timestamp > ?
           AND timestamp NOT LIKE '%' || ?
         ORDER BY timestamp`,
        [group_id, timestamp, client_id],
      );

      newMessages = newMessages.map(msg => ({
        ...msg,
        value: deserializeValue(msg.value),
      }));
    }
  }

  res.send(
    JSON.stringify({
      status: 'ok',
      data: { messages: newMessages, merkle: trie },
    }),
  );
});

app.get('/ping', (req, res) => {
  res.send('ok');
});

app.listen(8006);
