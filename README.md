# Credence Credit Management

A small store credit management web app with a Node.js JSON API, MySQL/MariaDB storage, and a responsive browser interface.

## Project folders

- `frontend/` contains the HTML, JavaScript, and CSS.
- `backend/` contains the Node.js API server.
- `database/data.sql` defines the MySQL tables.
- MySQL/MariaDB stores customer accounts, applications, payments, and credit sales.

## Run locally

1. Install Node.js 24 or newer and MySQL or MariaDB.
2. In phpMyAdmin, create a database named `credit_system_app`, then select it. The app initializes its tables automatically from `database/data.sql`.
3. Install the Node.js dependency:

   ```sh
   npm install
   ```

4. If you have data in the old `credit_system.db` SQLite file, set the same MySQL connection variables shown below and run `npm run migrate:sqlite` **before starting the app**. The importer preserves accounts, applications, payments, credit sales, and the admin login; it refuses to import if any target table already contains data. The SQLite file is left unchanged.

5. Set the connection variables for your MySQL server, then run `run.bat` or:

   ```powershell
   $env:MYSQL_HOST = "127.0.0.1"
   $env:MYSQL_PORT = "3306"
   $env:MYSQL_USER = "root"
   $env:MYSQL_PASSWORD = "your-password"
   $env:MYSQL_DATABASE = "credit_system_app"
   npm start
   ```

   `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, and    `MYSQL_DATABASE` can be set to match your MySQL/MariaDB configuration. Defaults are `127.0.0.1`, `3306`, `root`, an empty password, and `credit_system_app`. Never put a real database password in source control. You can also start the server with `npm run dev`; `npm start` remains available.

6. Open [http://127.0.0.1:5000](http://127.0.0.1:5000).

The server creates any missing tables on startup and adds sample accounts and applications when the accounts table is empty. New accounts, applications, payments, and credit purchases are saved directly in MySQL/MariaDB and remain after server restarts. Back up the MySQL database to retain your data.

On first launch, create one administrator username and password. Customers are ledger records only and do not have login accounts. The administrator password is stored as a salted hash.

## Included workflows

- Dashboard receivables, overdue balance, upcoming due dates, and customer count
- Customer list with search and CSV export
- Customer records with balances owed
- Credit purchase recording, due dates, and customer balances
- Optional per-customer purchase limits (unlimited by default)
- Customer credit requests, review, approval, and decline
- Payment recording that reduces customer balances
- Transaction history for credit sales and payments
- MySQL-backed JSON endpoints under `/api`

This is a local starter system: the administrator profile and sample data are demonstration content. It does not include user authentication or production deployment hardening.
