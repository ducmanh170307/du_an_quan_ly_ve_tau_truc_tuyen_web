const { sql, databaseConfig } = require('../src/config/db');

async function main() {
  const pool = await new sql.ConnectionPool(databaseConfig()).connect();
  try {
    const result = await pool.request().query(`
      SELECT DB_NAME() AS database_name,
        OBJECT_ID(N'dbo.Payments', N'U') AS payments,
        OBJECT_ID(N'dbo.PayBookingDemo', N'P') AS payment_procedure,
        OBJECT_ID(N'dbo.CancelBookingHold', N'P') AS cancel_procedure,
        OBJECT_ID(N'dbo.AdminWriteTrip', N'P') AS admin_procedure,
        HAS_PERMS_BY_NAME('dbo.PayBookingDemo','OBJECT','EXECUTE') AS can_pay,
        (SELECT COUNT(*) FROM dbo.Users WHERE [role] = 'ADMIN' AND is_active = 1) AS admins;
    `);
    const row = result.recordset[0];
    if (row.database_name.toLowerCase() !== 'trainticketdb' || !row.payments || !row.payment_procedure
        || !row.cancel_procedure || !row.admin_procedure || row.can_pay !== 1 || row.admins < 1) {
      throw new Error('SETUP_INCOMPLETE');
    }
    console.log('Đã kiểm tra kết nối, thủ tục, bảng thanh toán và tài khoản quản trị.');
  } finally {
    await pool.close();
  }
}

main().catch(error => {
  console.error('Kiểm tra cơ sở dữ liệu thất bại. Mã: ' + (error.code || error.message));
  process.exitCode = 1;
});
