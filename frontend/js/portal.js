'use strict';

window.trainPortal = (() => {
  const get = id => document.getElementById(id);
  const money = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });
  const time = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short'
  });
  const statuses = {
    PENDING_PAYMENT: 'Chờ thanh toán', PAID: 'Đã thanh toán', CANCELLED: 'Đã hủy',
    EXPIRED: 'Đã hết hạn', OPEN: 'Mở bán', CLOSED: 'Đóng bán',
    HELD: 'Đang giữ', ISSUED: 'Đã cấp vé'
  };

  function status(element, message, state = '') {
    element.textContent = message;
    element.dataset.state = state;
    element.hidden = !message;
  }

  async function request(path, options = {}) {
    const { method = 'GET', body } = options;
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(25000)
      });
    } catch {
      throw new Error('Không kết nối được máy chủ. Vui lòng thử lại.');
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true) {
      throw Object.assign(new Error(result?.message || 'Máy chủ chưa hoàn tất yêu cầu.'), {
        status: response.status, code: result?.code
      });
    }
    return result;
  }

  function formatTime(value) {
    const date = new Date(value);
    return value && Number.isFinite(+date) ? time.format(date) : '—';
  }

  function tableRows(body, rows) {
    const fragment = document.createDocumentFragment();
    for (const values of rows) {
      const row = document.createElement('tr');
      for (const value of values) {
        const cell = document.createElement('td');
        if (value instanceof Node) cell.append(value);
        else cell.textContent = String(value ?? '—');
        row.append(cell);
      }
      fragment.append(row);
    }
    body.replaceChildren(fragment);
  }

  return { get, request, status, money: value => money.format(value), formatTime, statuses, tableRows };
})();
