const express = require('express');
const { sql } = require('../config/db');
const { requireSession, rejectSession } = require('../utils/session');
const { invalid, positiveId, jsonBody } = require('../utils/validation');

const router = express.Router();
router.use(requireSession, jsonBody);
const demoEnabled = () => process.env.DEMO_PAYMENT === 'true';

router.get('/:bookingId', async (req, res) => {
  const id = positiveId(req.params.bookingId, 'Mã đơn');
  const result = await req.db.request()
    .input('booking_id', sql.Int, id)
    .input('user_id', sql.Int, req.user.id)
    .input('is_admin', sql.Bit, req.user.role === 'ADMIN')
    .query(`
      DECLARE @now DATETIME2 = SYSUTCDATETIME();
      SELECT booking.id, booking.code, booking.user_id, booking.trip_id,
        CASE WHEN booking.status = 'PENDING_PAYMENT' AND booking.expires_at <= @now
          THEN 'EXPIRED' ELSE booking.status END AS status,
        booking.total_amount, booking.expires_at, booking.created_at,
        trip.code AS trip_code, trip.departure_at, trip.arrival_at, train.code AS train_code,
        origin.name AS origin_name, destination.name AS destination_name,
        payment.paid_at, item.id AS item_id, item.passenger_name, item.price_snapshot,
        CASE WHEN booking.status = 'PAID' AND item.status = 'ISSUED' THEN item.ticket_code END AS ticket_code,
        item.status AS item_status, carriage.carriage_number, carriage.carriage_type, seat.seat_number
      FROM dbo.Bookings AS booking
      INNER JOIN dbo.Trips AS trip ON trip.id = booking.trip_id
      INNER JOIN dbo.Trains AS train ON train.id = trip.train_id
      INNER JOIN dbo.Stations AS origin ON origin.id = trip.origin_id
      INNER JOIN dbo.Stations AS destination ON destination.id = trip.destination_id
      LEFT JOIN dbo.Payments AS payment ON payment.booking_id = booking.id AND payment.status = 'SUCCESS'
      LEFT JOIN dbo.BookingItems AS item ON item.booking_id = booking.id
      LEFT JOIN dbo.TripSeats AS trip_seat ON trip_seat.id = item.trip_seat_id AND trip_seat.trip_id = item.trip_id
      LEFT JOIN dbo.Seats AS seat ON seat.id = trip_seat.seat_id
      LEFT JOIN dbo.Carriages AS carriage ON carriage.id = seat.carriage_id
      WHERE booking.id = @booking_id AND (booking.user_id = @user_id OR @is_admin = 1)
      ORDER BY carriage.carriage_number, seat.seat_number, item.id;
    `);

  const rows = result.recordset;
  if (!rows.length) return res.status(404).json({ ok: false, message: 'Không tìm thấy đơn.' });
  const {
    code, user_id, trip_id, status, total_amount, expires_at, created_at, paid_at,
    trip_code, train_code, origin_name, destination_name, departure_at, arrival_at
  } = rows[0];
  res.json({
    ok: true,
    booking: {
      id, code, trip_id, status, total_amount, expires_at, created_at, paid_at,
      trip_code, train_code, origin_name, destination_name, departure_at, arrival_at
    },
    can_pay: demoEnabled() && req.user.role === 'CUSTOMER' && req.user.id === user_id && status === 'PENDING_PAYMENT',
    demo_payment_enabled: demoEnabled(),
    items: rows.filter(row => row.item_id !== null).map(row => ({
      id: row.item_id,
      passenger_name: row.passenger_name,
      carriage_number: row.carriage_number,
      carriage_type: row.carriage_type,
      seat_number: row.seat_number,
      price: row.price_snapshot,
      ticket_code: row.ticket_code,
      status: row.item_status
    }))
  });
});

const paymentErrors = new Map([
  [51201, [400, 'INVALID_PAYMENT', 'Thông tin thanh toán mô phỏng không hợp lệ.']],
  [51202, [404, 'BOOKING_NOT_FOUND', 'Không tìm thấy đơn của bạn.']],
  [51203, [409, 'BOOKING_SEATS_CHANGED', 'Chỗ giữ đã thay đổi. Vui lòng tải lại đơn.']],
  [51204, [503, 'BOOKING_BUSY', 'Chuyến đang có giao dịch khác. Hãy gửi lại yêu cầu.']],
  [51205, [409, 'REQUEST_CONFLICT', 'Mã yêu cầu đã được dùng cho kết quả khác.']]
]);

router.post('/:bookingId/demo-payment', async (req, res) => {
  if (!demoEnabled() || req.user.role !== 'CUSTOMER') {
    return res.status(403).json({ ok: false, message: 'Thanh toán mô phỏng chỉ dành cho khách hàng khi chế độ demo được bật.' });
  }
  const id = positiveId(req.params.bookingId, 'Mã đơn');
  const { idempotency_key: key, outcome } = req.body ?? {};
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key)
      || (outcome !== 'SUCCESS' && outcome !== 'FAILED')) {
    throw invalid('Mã yêu cầu hoặc kết quả thanh toán mô phỏng không hợp lệ.');
  }
  try {
    const result = await req.db.request()
      .input('user_id', sql.Int, req.user.id)
      .input('booking_id', sql.Int, id)
      .input('idempotency_key', sql.VarChar(64), key)
      .input('outcome', sql.VarChar(8), outcome)
      .execute('dbo.PayBookingDemo');
    const row = result.recordset[0];
    if (row?.id !== id || !['PENDING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED'].includes(row.status)) {
      throw new Error('Invalid payment result');
    }
    res.json({
      ok: true,
      is_replay: row.is_replay === true || row.is_replay === 1,
      booking: { id: row.id, code: row.code, status: row.status, total_amount: row.total_amount },
      payment: row.payment_id === null ? null
        : { id: row.payment_id, status: row.payment_status, paid_at: row.paid_at, method: 'DEMO' }
    });
  } catch (error) {
    const number = error.number ?? error.originalError?.info?.number;
    if (number === 51207) return rejectSession(res);
    const response = paymentErrors.get(number === 1205 ? 51204 : number);
    if (!response) throw error;
    const [status, code, message] = response;
    if (status === 503) res.set('Retry-After', '1');
    res.status(status).json({ ok: false, code, message });
  }
});

module.exports = router;
