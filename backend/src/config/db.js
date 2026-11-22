const path = require('node:path');
const sql = require('mssql');

// Doc dung file backend/.env.
require('dotenv').config({
  path: path.resolve(__dirname, '../../.env')
});

let poolPromise;

function databaseConfig(overrides = {}) {
  const config = {
    server: process.env.DB_SERVER,
    port: Number(process.env.DB_PORT || 1433),
    database: process.env.DB_DATABASE,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: {
      encrypt: process.env.DB_ENCRYPT !== 'false',
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true',
      useUTC: true
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 5000,
    requestTimeout: 12000,
    ...overrides
  };
  if (['server', 'database', 'user', 'password'].some(key => !config[key])) {
    throw Object.assign(new Error('Thiếu cấu hình kết nối trong backend/.env.'), { code: 'DB_CONFIG_MISSING' });
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw Object.assign(new Error('DB_PORT không hợp lệ.'), { code: 'DB_CONFIG_INVALID' });
  }
  return config;
}

// Dung lai connection pool cho cac API.
async function getPool() {
  if (!poolPromise) {
    const pool = new sql.ConnectionPool(databaseConfig());

    pool.on('error', (error) => {
      console.error('Lỗi connection pool:', error.code || 'UNKNOWN');
    });

    poolPromise = pool.connect().catch(async (error) => {
      poolPromise = undefined;
      await pool.close().catch(() => {});
      throw error;
    });
  }

  return poolPromise;
}

module.exports = { sql, getPool, databaseConfig };

// Chi chay kiem tra khi go: node src/config/db.js.
if (require.main === module) {
  (async () => {
    let pool;
    try {
      pool = await getPool();

      const database = await pool.request().query(
        'SELECT DB_NAME() AS database_name'
      );
      console.log('Kết nối SQL Server thành công.');
      console.log('Cơ sở dữ liệu:', database.recordset[0].database_name);

      const stations = await pool.request().query(
        'SELECT id, code, name, city FROM dbo.Stations ORDER BY id'
      );
      console.table(stations.recordset);
    } catch (error) {
      console.error('Kết nối hoặc truy vấn thất bại.');
      console.error('Mã lỗi:', error.code || 'UNKNOWN');
      process.exitCode = 1;
    } finally {
      if (pool) await pool.close();
    }
  })();
}
