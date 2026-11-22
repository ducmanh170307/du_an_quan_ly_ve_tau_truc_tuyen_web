'use strict';

(() => {
  const { get, request, status, money, formatTime, statuses, tableRows } = window.trainPortal;
  const ids = new URLSearchParams(location.search).getAll('booking_id');
  const id = Number(ids[0]);
  const notice = get('order-notice');
  const payButton = get('pay-button');
  const outcome = get('payment-outcome');
  const reload = get('reload-order');
  let current = null;
  let pending = null;
  let busy = false;

  function updateControls() {
    reload.disabled = busy;
    outcome.disabled = busy || pending !== null;
    payButton.disabled = busy || (!pending && (
      !current?.can_pay || Date.parse(current.booking.expires_at) <= Date.now()
    ));
    payButton.textContent = busy ? 'Đang xử lý…'
      : pending ? 'Gửi lại yêu cầu' : 'Thực hiện thanh toán mô phỏng';
  }

  function updateTime() {
    if (!current?.can_pay) return;
    const seconds = Math.max(0, Math.ceil((Date.parse(current.booking.expires_at) - Date.now()) / 1000));
    get('payment-time').textContent = seconds
      ? 'Thời gian giữ chỗ còn ' + Math.floor(seconds / 60) + ' phút ' + seconds % 60 + ' giây.'
      : 'Đã tới hạn giữ chỗ. Tải lại đơn để xem trạng thái.';
    updateControls();
  }

  function render(result) {
    const { booking, items } = result;
    if (booking?.id !== id || !Array.isArray(items)) throw new Error('Thông tin đơn chưa hợp lệ.');
    current = result;
    get('order-journey').textContent = booking.origin_name + ' → ' + booking.destination_name;
    get('order-code').textContent = 'Đơn ' + booking.code + ' · Chuyến ' + booking.trip_code + ' · Tàu ' + booking.train_code;
    get('order-status').textContent = statuses[booking.status] ?? booking.status;
    get('order-total').textContent = money(booking.total_amount);
    get('order-departure').textContent = formatTime(booking.departure_at);
    get('order-arrival').textContent = formatTime(booking.arrival_at);
    get('order-expires-row').hidden = booking.status !== 'PENDING_PAYMENT';
    get('order-expires').textContent = formatTime(booking.expires_at);
    get('order-paid-row').hidden = !booking.paid_at;
    get('order-paid').textContent = formatTime(booking.paid_at);
    get('order-data').hidden = false;
    get('ticket-card').hidden = items.length === 0;
    get('print-tickets').hidden = booking.status !== 'PAID' || !items.some(item => item.ticket_code);
    get('payment-card').hidden = !result.can_pay && !pending;
    tableRows(get('ticket-rows'), items.map(item => [
      item.passenger_name, item.carriage_number, item.seat_number, money(item.price),
      booking.status === 'EXPIRED' && item.status === 'HELD' ? statuses.EXPIRED
        : (statuses[item.status] ?? item.status),
      item.ticket_code ?? '—'
    ]));
    updateTime();
  }

  async function load(keepNotice = false) {
    if (busy) return;
    busy = true;
    updateControls();
    if (!keepNotice) status(notice, 'Đang tải thông tin đơn…', 'loading');
    get('order-login').hidden = true;
    try {
      const result = await request('/api/bookings/' + id);
      if (result.booking?.status !== 'PENDING_PAYMENT') pending = null;
      render(result);
      if (!keepNotice) status(notice, '');
    } catch (error) {
      status(notice, error.message, 'error');
      if (error.status === 401 || error.status === 404) {
        current = null;
        for (const name of ['order-data', 'ticket-card', 'payment-card']) get(name).hidden = true;
      }
      get('order-login').hidden = error.status !== 401;
    } finally {
      busy = false;
      updateControls();
    }
  }

  async function pay(event) {
    event.preventDefault();
    if (busy || payButton.disabled) return;
    pending ??= { idempotency_key: crypto.randomUUID(), outcome: outcome.value };
    busy = true;
    updateControls();
    status(notice, 'Đang gửi thanh toán mô phỏng…', 'loading');
    let refresh = false;
    try {
      const result = await request('/api/bookings/' + id + '/demo-payment', { method: 'POST', body: pending });
      pending = null;
      current = null;
      refresh = true;
      get('payment-card').hidden = true;
      const booking = result.booking;
      if (booking?.status === 'PAID') status(notice, 'Thanh toán mô phỏng thành công. Vé đã được cấp.', 'success');
      else if (booking?.status === 'PENDING_PAYMENT' && result.payment?.status === 'FAILED') {
        status(notice, 'Lần thử mô phỏng thất bại. Bạn có thể thử lại khi đơn còn hạn.', 'error');
      } else status(notice, 'Đơn ' + (statuses[booking?.status] ?? 'đã thay đổi') + '.', 'error');
    } catch (error) {
      if (error.status && error.status < 500) pending = null;
      status(notice, error.message, 'error');
      get('order-login').hidden = error.status !== 401;
      refresh = error.status === 409;
    } finally {
      busy = false;
      updateControls();
    }
    if (refresh) await load(true);
  }

  get('print-tickets').addEventListener('click', () => window.print());
  get('payment-form').addEventListener('submit', pay);
  reload.addEventListener('click', () => load());
  if (ids.length !== 1 || !/^[1-9]\d{0,9}$/.test(ids[0]) || id > 2147483647) {
    reload.hidden = true;
    status(notice, 'Mã đơn không hợp lệ. Hãy mở đơn từ trang Tài khoản.', 'error');
    return;
  }
  setInterval(updateTime, 1000);
  load();
})();
