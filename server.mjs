import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import mysql from 'mysql2/promise';

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(backendDir, '..');
const frontendDir = path.join(root, 'frontend');
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'credit_system_app',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
  decimalNumbers: true
});

async function execute(sql, params = [], connection = pool) {
  const [result] = await connection.execute(sql, params);
  return result;
}
async function get(sql, params = [], connection = pool) {
  const rows = await execute(sql, params, connection);
  return rows[0] || null;
}
async function all(sql, params = [], connection = pool) {
  return execute(sql, params, connection);
}

async function initializeDatabase() {
  const schema = await readFile(path.join(root, 'database', 'data.sql'), 'utf8');
  for (const statement of schema.split(';').map(sql => sql.trim()).filter(Boolean)) {
    await pool.query(statement);
  }

  if (!await get('SELECT id FROM system_migrations WHERE id=?', ['sample_customers_unlimited'])) {
    await execute("UPDATE accounts SET credit_limit=0 WHERE account_no IN ('CA-2025-001','CA-2025-002','CA-2025-003','CA-2025-004','CA-2025-005')");
    await execute('INSERT INTO system_migrations(id) VALUES(?)', ['sample_customers_unlimited']);
  }
  if ((await get('SELECT COUNT(*) AS n FROM accounts')).n === 0) {
    const today = new Date();
    const offset = days => {
      const date = new Date(today);
      date.setDate(date.getDate() + days);
      return date.toISOString().slice(0, 10);
    };
    const accounts = [
      ['CA-2025-001','Olivia Rhye','olivia@example.com','0917 555 0142',0,68400,'Active',offset(2),'2025-06-12 00:00:00'],
      ['CA-2025-002','Phoenix Baker','phoenix@example.com','0918 555 0138',0,22600,'Active',offset(-12),'2025-07-03 00:00:00'],
      ['CA-2025-003','Lana Steiner','lana@example.com','0920 555 0107',0,118500,'Active',offset(4),'2025-07-18 00:00:00'],
      ['CA-2025-004','Demi Wilkinson','demi@example.com','0916 555 0176',0,0,'Pending',null,'2025-08-01 00:00:00'],
      ['CA-2025-005','Candice Wu','candice@example.com','0919 555 0155',0,39250,'Active',offset(-45),'2025-08-14 00:00:00']
    ];
    for (const account of accounts) {
      await execute('INSERT INTO accounts(account_no,name,email,phone,credit_limit,balance,status,due_date,created_at) VALUES(?,?,?,?,?,?,?,?,?)', account);
    }
    const applications = [
      ['Demi Wilkinson','demi@example.com','0916 555 0176',60000,12,'Home improvement',45000,'Pending','2025-08-01 00:00:00'],
      ['Natali Craig','natali@example.com','0917 555 0122',85000,18,'Business',62000,'Pending','2025-08-18 00:00:00'],
      ['Drew Cano','drew@example.com','0918 555 0191',40000,12,'Education',38000,'Review','2025-08-19 00:00:00']
    ];
    for (const application of applications) {
      await execute('INSERT INTO applications(applicant,email,phone,amount,term,purpose,income,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)', application);
    }
  }
}

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};
const bad = (res, message, status = 400) => json(res, status, { error: message });
const sessions = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;
function cookie(req, name) {
  return (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1) || '';
}
function session(req) {
  const token = cookie(req, 'creditdesk_session');
  const record = sessions.get(token);
  if (!record) return null;
  if (record.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return record;
}
function setSession(res, token) {
  res.setHeader('Set-Cookie', `creditdesk_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', 'creditdesk_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}
function passwordHash(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
async function accountList(q = '') {
  const like = `%${q}%`;
  return all('SELECT * FROM accounts WHERE name LIKE ? OR account_no LIKE ? OR email LIKE ? ORDER BY id DESC', [like, like, like]);
}

async function api(req, res, url) {
  const p = url.pathname, method = req.method;
  if (p === '/api/auth/status' && method === 'GET') {
    return json(res, 200, {
      configured: !!await get('SELECT id FROM admin_user WHERE id=1'),
      authenticated: !!session(req)
    });
  }
  if (p === '/api/auth/setup' && method === 'POST') {
    const d = await body(req), username = String(d.username || '').trim(), password = String(d.password || '');
    if (await get('SELECT id FROM admin_user WHERE id=1')) return bad(res, 'The administrator is already set up. Sign in instead.', 409);
    if (username.length < 3 || username.length > 40) return bad(res, 'Choose a username between 3 and 40 characters.');
    if (password.length < 10) return bad(res, 'Use a password with at least 10 characters.');
    const salt = randomBytes(16).toString('hex'), hash = passwordHash(password, salt);
    await execute('INSERT INTO admin_user(id,username,password_salt,password_hash) VALUES(1,?,?,?)', [username, salt, hash]);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { username, expires: Date.now() + SESSION_MS });
    setSession(res, token);
    return json(res, 201, { username });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const d = await body(req), username = String(d.username || '').trim(), password = String(d.password || '');
    const admin = await get('SELECT * FROM admin_user WHERE id=1');
    if (!admin) return bad(res, 'Set up the administrator account first.', 409);
    const candidate = passwordHash(password, admin.password_salt);
    if (username !== admin.username || !timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(admin.password_hash, 'hex'))) {
      return bad(res, 'Username or password is incorrect.', 401);
    }
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { username, expires: Date.now() + SESSION_MS });
    setSession(res, token);
    return json(res, 200, { username });
  }
  if (p === '/api/auth/logout' && method === 'POST') {
    sessions.delete(cookie(req, 'creditdesk_session'));
    clearSession(res);
    return json(res, 200, { ok: true });
  }
  if (p.startsWith('/api/') && !session(req)) return bad(res, 'Please sign in as the administrator.', 401);
  if (p === '/api/summary' && method === 'GET') {
    const summary = await get('SELECT COUNT(*) AS accounts,COALESCE(SUM(credit_limit),0) AS credit_limit,COALESCE(SUM(balance),0) AS outstanding FROM accounts');
    const pending = (await get("SELECT COUNT(*) AS n FROM applications WHERE status='Pending'")).n;
    const overdue = (await get('SELECT COALESCE(SUM(balance),0) AS amount FROM accounts WHERE balance>0 AND due_date < ?', [new Date().toISOString().slice(0, 10)])).amount;
    const collected = (await get('SELECT COALESCE(SUM(amount),0) AS amount FROM payments')).amount;
    const recent = await all('SELECT * FROM applications ORDER BY created_at DESC,id DESC LIMIT 5');
    return json(res, 200, {
      ...summary, pending, overdue, collected,
      collection_rate: collected + summary.outstanding ? Math.round(collected / (collected + summary.outstanding) * 1000) / 10 : 0,
      recent, due: summary.outstanding,
      utilization: summary.credit_limit ? Math.round(summary.outstanding / summary.credit_limit * 1000) / 10 : 0
    });
  }
  if (p === '/api/accounts' && method === 'GET') return json(res, 200, await accountList(url.searchParams.get('q') || ''));
  if (p === '/api/accounts' && method === 'POST') {
    const d = await body(req), name = String(d.name || '').trim(), email = String(d.email || '').trim(), limit = Number(d.credit_limit || 0);
    if (!name) return bad(res, 'Customer name is required.');
    if (!Number.isFinite(limit) || limit < 0) return bad(res, 'Enter a valid credit limit.');
    const count = (await get('SELECT COUNT(*) AS n FROM accounts')).n;
    const accountNo = `CA-${new Date().toISOString().slice(2, 7).replace('-', '')}-${String(count + 1).padStart(4, '0')}`;
    try {
      const result = await execute("INSERT INTO accounts(account_no,name,email,phone,credit_limit,status) VALUES(?,?,?,?,?,'Active')", [accountNo, name, email, String(d.phone || ''), limit]);
      return json(res, 201, await get('SELECT * FROM accounts WHERE id=?', [result.insertId]));
    } catch {
      return bad(res, 'Could not create account. Check the details and try again.');
    }
  }
  const limitMatch = p.match(/^\/api\/accounts\/(\d+)\/limit$/);
  if (limitMatch && method === 'PATCH') {
    const id = Number(limitMatch[1]), d = await body(req), limit = Number(d.credit_limit || 0), account = await get('SELECT * FROM accounts WHERE id=?', [id]);
    if (!account) return bad(res, 'Customer account not found.', 404);
    if (!Number.isFinite(limit) || limit < 0) return bad(res, 'Enter a valid purchase limit, or leave it blank for no limit.');
    if (limit > 0 && limit < account.balance) return bad(res, 'The limit cannot be lower than the amount this customer currently owes.');
    await execute('UPDATE accounts SET credit_limit=? WHERE id=?', [limit, id]);
    return json(res, 200, await get('SELECT * FROM accounts WHERE id=?', [id]));
  }
  if (p === '/api/applications' && method === 'GET') return json(res, 200, await all('SELECT * FROM applications ORDER BY id DESC'));
  if (p === '/api/applications' && method === 'POST') {
    const d = await body(req), applicant = String(d.applicant || '').trim(), email = String(d.email || '').trim();
    const amount = Number(d.amount), term = Number(d.term || 12), income = Number(d.income || 0);
    if (!applicant || !d.amount) return bad(res, 'Customer name and requested credit limit are required.');
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(term) || term <= 0 || !Number.isFinite(income)) return bad(res, 'Please enter valid application details.');
    const result = await execute('INSERT INTO applications(applicant,email,phone,amount,term,purpose,income) VALUES(?,?,?,?,?,?,?)', [
      applicant, email, String(d.phone || ''), amount, term, String(d.purpose || ''), income
    ]);
    return json(res, 201, await get('SELECT * FROM applications WHERE id=?', [result.insertId]));
  }
  const appMatch = p.match(/^\/api\/applications\/(\d+)$/);
  if (appMatch && method === 'PATCH') {
    const id = Number(appMatch[1]), status = (await body(req)).status;
    if (!['Approved', 'Declined', 'Review', 'Pending'].includes(status)) return bad(res, 'Unsupported application status.');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const row = await get('SELECT * FROM applications WHERE id=? FOR UPDATE', [id], connection);
      if (!row) {
        await connection.rollback();
        return bad(res, 'Application not found.', 404);
      }
      await execute('UPDATE applications SET status=? WHERE id=?', [status, id], connection);
      if (status === 'Approved' && row.status !== 'Approved') {
        const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
        const accountNo = `CA-${new Date().toISOString().slice(2, 7).replace('-', '')}-${String(id).padStart(4, '0')}`;
        await execute("INSERT INTO accounts(account_no,name,email,phone,credit_limit,balance,status,due_date) VALUES(?,?,?,?,?,0,'Active',?)", [
          accountNo, row.applicant, row.email, row.phone, row.amount, dueDate
        ], connection);
      }
      await connection.commit();
      return json(res, 200, await get('SELECT * FROM applications WHERE id=?', [id]));
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  const paymentMatch = p.match(/^\/api\/accounts\/(\d+)\/payments$/);
  if (paymentMatch && method === 'POST') {
    const id = Number(paymentMatch[1]), d = await body(req), amount = Number(d.amount);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const account = await get('SELECT * FROM accounts WHERE id=? FOR UPDATE', [id], connection);
      if (!account) {
        await connection.rollback();
        return bad(res, 'Account not found.', 404);
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        await connection.rollback();
        return bad(res, 'Payment amount must be greater than zero.');
      }
      if (amount > account.balance) {
        await connection.rollback();
        return bad(res, 'Payment cannot exceed the outstanding balance.');
      }
      await execute('INSERT INTO payments(account_id,amount,paid_on,note) VALUES(?,?,CURRENT_DATE,?)', [id, amount, String(d.note || '')], connection);
      await execute("UPDATE accounts SET balance=balance-?,status=CASE WHEN balance-?<=0 THEN 'Paid' ELSE status END WHERE id=?", [amount, amount, id], connection);
      await connection.commit();
      return json(res, 200, await get('SELECT * FROM accounts WHERE id=?', [id]));
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  if (p === '/api/payments' && method === 'GET') {
    return json(res, 200, await all('SELECT p.*,a.name,a.account_no FROM payments p JOIN accounts a ON a.id=p.account_id ORDER BY p.id DESC LIMIT 50'));
  }
  if (p === '/api/transactions' && method === 'GET') {
    return json(res, 200, await all(`
      SELECT * FROM (
        SELECT p.id,p.account_id,a.name,a.account_no,p.amount,p.paid_on AS transaction_date,'Payment' AS type,p.note AS details,NULL AS due_date
        FROM payments p JOIN accounts a ON a.id=p.account_id
        UNION ALL
        SELECT s.id,s.account_id,a.name,a.account_no,s.amount,DATE(s.created_at) AS transaction_date,'Credit sale' AS type,s.description AS details,s.due_date
        FROM credit_sales s JOIN accounts a ON a.id=s.account_id
      ) AS transactions ORDER BY transaction_date DESC,id DESC LIMIT 100
    `));
  }
  const chargeMatch = p.match(/^\/api\/accounts\/(\d+)\/charges$/);
  if (chargeMatch && method === 'POST') {
    const id = Number(chargeMatch[1]), d = await body(req), amount = Number(d.amount);
    const description = String(d.description || '').trim(), dueDate = String(d.due_date || '');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const account = await get('SELECT * FROM accounts WHERE id=? FOR UPDATE', [id], connection);
      if (!account) {
        await connection.rollback();
        return bad(res, 'Customer account not found.', 404);
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        await connection.rollback();
        return bad(res, 'Sale amount must be greater than zero.');
      }
      if (account.credit_limit > 0 && account.balance + amount > account.credit_limit) {
        await connection.rollback();
        return bad(res, 'This purchase would exceed the limit you set for this customer.');
      }
      await execute('INSERT INTO credit_sales(account_id,amount,description,due_date) VALUES(?,?,?,?)', [id, amount, description, dueDate || null], connection);
      await execute("UPDATE accounts SET balance=balance+?,status='Active',due_date=? WHERE id=?", [amount, dueDate || null, id], connection);
      await connection.commit();
      return json(res, 201, await get('SELECT * FROM accounts WHERE id=?', [id]));
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  if (p === '/api/credit-sales' && method === 'GET') {
    return json(res, 200, await all('SELECT s.*,a.name,a.account_no FROM credit_sales s JOIN accounts a ON a.id=s.account_id ORDER BY s.id DESC LIMIT 50'));
  }
  return bad(res, 'Not found.', 404);
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(frontendDir, relative);
    if (!file.startsWith(frontendDir + path.sep)) return bad(res, 'Not found.', 404);
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (error) {
    if (error instanceof SyntaxError) return bad(res, 'Invalid JSON request.');
    if (error.code === 'ENOENT') return bad(res, 'Not found.', 404);
    console.error(error);
    bad(res, 'Server error.', 500);
  }
});

try {
  await initializeDatabase();
  const port = Number(process.env.PORT || 5000);
  server.listen(port, '127.0.0.1', () => console.log(`CreditDesk running at http://127.0.0.1:${port}`));
} catch (error) {
  console.error('Could not connect to or initialize MySQL. Check MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE.', error);
  await pool.end();
  process.exitCode = 1;
}
