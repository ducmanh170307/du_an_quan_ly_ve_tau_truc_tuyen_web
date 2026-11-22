const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { sql, databaseConfig } = require('../src/config/db');
const { hashPassword } = require('../src/utils/password');

const full = process.argv.includes('--fresh');
const newAdmin = process.argv.includes('--new-admin');
const seedTrips = process.argv.includes('--seed-trips');
const dir = path.resolve(__dirname, '../../database');
const setupCredentials = process.env.TRAIN_TICKET_SETUP_SQL_USER ? {
  user: process.env.TRAIN_TICKET_SETUP_SQL_USER,
  password: process.env.TRAIN_TICKET_SETUP_SQL_PASSWORD
} : {};
const procedures = [
  'CreateBookingHold', 'CancelBookingHold', 'PayBookingDemo', 'ExpireBookingHolds',
  'AdminCreateTrain', 'AdminDeleteTrain', 'AdminWriteTrip'
];
const schema = [
  '01_stations.sql', '02_trains.sql', '03_carriages.sql', '04_seats.sql',
  '05_trips.sql', '06_trip_seats.sql', '07_users.sql', '08_user_sessions.sql',
  '09_bookings.sql', '10_hold_booking.sql'
];
const upgrade = ['11_cancel_booking.sql', '12_demo_payments.sql', '13_admin_catalog.sql'];

async function connect(database, credentials = {}) {
  const pool = new sql.ConnectionPool(databaseConfig({
    ...credentials, database, requestTimeout: 120000,
    pool: { min: 0, max: 1, idleTimeoutMillis: 30000 }
  }));
  try {
    return await pool.connect();
  } catch (error) {
    await pool.close().catch(() => {});
    throw error;
  }
}

async function executeFile(pool, name) {
  const source = await readFile(path.join(dir, name), 'utf8');
  for (const batch of source.split(/^[ \t]*GO[ \t]*(?:--[^\r\n]*)?\r?$/im)) {
    if (batch.trim()) await pool.request().batch(batch);
  }
  console.log('Đã áp dụng ' + name);
}

async function verifyPermissions(pool, grantor) {
  const result = await pool.request().query(`
    SELECT USER_NAME() AS db_user,
      HAS_PERMS_BY_NAME('dbo.Payments', 'OBJECT', 'SELECT') AS can_read_payments,
      ${procedures.map(name => "HAS_PERMS_BY_NAME('dbo." + name + "', 'OBJECT', 'EXECUTE') AS [" + name + "]").join(', ')};
  `);
  const user = result.recordset[0];
  const missing = procedures.filter(name => user[name] !== 1);
  if (missing.length || user.can_read_payments !== 1) {
    const escaped = '[' + user.db_user.replace(/]/g, ']]') + ']';
    const commands = missing.map(name => 'GRANT EXECUTE ON OBJECT::dbo.' + name + ' TO ' + escaped + ';');
    if (user.can_read_payments !== 1) commands.push('GRANT SELECT ON OBJECT::dbo.Payments TO ' + escaped + ';');
    await grantor.request().batch(commands.join('\n'));
  }
}

async function ensureAdmin(pool) {
  const previous = await pool.request().query(`
    SELECT TOP (1) email FROM dbo.Users
    WHERE email LIKE N'admin.demo%@example.test' AND [role] = 'ADMIN' AND is_active = 1
    ORDER BY id DESC;
  `);
  if (!newAdmin && previous.recordset.length) {
    console.log('Quản trị viên demo: ' + previous.recordset[0].email + ' (dùng mật khẩu lần tạo trước).');
    return;
  }
  const email = 'admin.demo.' + randomBytes(4).toString('hex') + '@example.test';
  const password = randomBytes(18).toString('base64url');
  const hash = await hashPassword(password);
  await pool.request()
    .input('email', sql.NVarChar(254), email)
    .input('hash', sql.VarChar(255), hash)
    .query(`
      INSERT INTO dbo.Users (full_name, email, password_hash, [role])
      VALUES (N'Quản trị viên demo', @email, @hash, 'ADMIN');
    `);
  console.log('\nTài khoản quản trị demo mới');
  console.log('Email: ' + email);
  console.log('Mật khẩu (chỉ hiện lần này): ' + password + '\n');
}

async function main() {
  const appConfig = databaseConfig();
  if (appConfig.database.toLowerCase() !== 'trainticketdb') {
    throw Object.assign(new Error('DB_DATABASE trong backend/.env cần trỏ đến TrainTicketDB.'), { code: 'DB_CONFIG_INVALID' });
  }
  if (full) {
    // Tạo database trong master rồi tạo bảng với một kết nối trỏ đúng database.
    const master = await connect('master', setupCredentials);
    try {
      await master.request().batch("IF DB_ID(N'TrainTicketDB') IS NULL EXEC(N'CREATE DATABASE TrainTicketDB;');");
    } finally {
      await master.close();
    }
  }

  const pool = await connect(appConfig.database, setupCredentials);
  let appPool;
  try {
    const scripts = full ? [...schema, ...upgrade] : (seedTrips ? [...schema.slice(4, 6), ...upgrade] : upgrade);
    for (const name of scripts) await executeFile(pool, name);
    appPool = await connect(appConfig.database);
    await verifyPermissions(appPool, pool);
    await ensureAdmin(pool);
    console.log('Cơ sở dữ liệu TrainTicketDB đã sẵn sàng.');
  } finally {
    if (appPool) await appPool.close();
    await pool.close();
  }
}

main().catch(error => {
  const number = error.number ?? error.originalError?.info?.number;
  if (error.code === 'DB_CONFIG_MISSING' || error.code === 'DB_CONFIG_INVALID') console.error(error.message);
  else console.error('Thiết lập SQL Server thất bại. Mã: ' + (error.code || 'UNKNOWN') + (number ? ' / ' + number : ''));
  if (number === 208) console.error('Thiếu bảng gốc. Tạo cơ sở dữ liệu bằng npm run setup -- --fresh.');
  const credentialRequired = [229, 262, 916, 2760, 15247, 15151].includes(number);
  process.exitCode = credentialRequired ? 20 : 1;
});
