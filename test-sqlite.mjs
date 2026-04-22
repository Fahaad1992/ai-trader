import Database from 'better-sqlite3';
const db = new Database(':memory:');
db.exec('CREATE TABLE test (id INTEGER)');
db.prepare('INSERT INTO test VALUES (?)').run(1);
const row = db.prepare('SELECT * FROM test').get();
console.log('better-sqlite3 works:', row);
db.close();
