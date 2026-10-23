import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = process.env.CREDIT_DB || path.join(root, 'credit_system.db');
const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'credit_system_app',
  waitForConnections: true,
  connectionLimit: 1,
  dateStrings: true,
  decimalNumbers: true
});

const tables = {
  accounts: ['id', 'account_no', 'name', 'email', 'phone', 'credit_limit', 'balance', 'status', 'due_date', 'created_at'],
  applications: ['id', 'applicant', 'email', 'phone', 'amount', 'term', 'purpose', 'income', 'status', 'created_at'],
  payments: ['id', 'account_id', 'amount', 'paid_on', 'note'],
  credit_sales: ['id', 'account_id', 'amount', 'description', 'due_date', 'created_at'],
  system_migrations: ['id', 'applied_at'],
  admin_user: ['id', 'username', 'password_salt', 'password_hash', 'created_at']
};

async function main() {
  const schema = await readFile(path.join(root, 'database', 'data.sql'), 'utf8');
  for (const statement of schema.split(';').map(sql => sql.trim()).filter(Boolean)) {
    await pool.query(statement);
  }

  const connection = await pool.getConnection();
  try {
    for (const table of Object.keys(tables)) {
      const [rows] = await connection.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
      if (Number(rows[0].n) !== 0) {
        throw new Error(`The MySQL table "${table}" is not empty. Migration stopped without changing data.`);
      }
    }

    await connection.beginTransaction();
    for (const [table, columns] of Object.entries(tables)) {
      const rows = sqlite.prepare(`SELECT ${columns.map(column => `"${column}"`).join(',')} FROM "${table}"`).all();
      if (!rows.length) continue;
      const fields = columns.map(column => `\`${column}\``).join(',');
      const placeholders = columns.map(() => '?').join(',');
      const insert = `INSERT INTO \`${table}\` (${fields}) VALUES (${placeholders})`;
      for (const row of rows) {
        await connection.execute(insert, columns.map(column => row[column]));
      }
      console.log(`Imported ${rows.length} row(s) from ${table}.`);
    }
    await connection.commit();
    console.log(`SQLite data from "${sourcePath}" was imported successfully.`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

try {
  await main();
} catch (error) {
  console.error('SQLite-to-MySQL migration failed:', error.message);
  process.exitCode = 1;
} finally {
  sqlite.close();
  await pool.end();
}
