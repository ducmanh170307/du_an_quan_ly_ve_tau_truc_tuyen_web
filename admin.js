'use strict';

(() => {
  const { get, request, status, money, formatTime, statuses, tableRows } = window.trainPortal;
  const notice = get('admin-status');
  const workspace = get('admin-workspace');
  const editor = get('catalog-editor');
  const tabs = [...document.querySelectorAll('[data-resource]')];
  const active = row => row.is_active ? 'Hoạt động' : 'Ngừng hoạt động';
  const tripStatuses = ['OPEN', 'CLOSED', 'CANCELLED'];
  const bookingStatuses = ['PENDING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED'];
  const definitions = {
    stations: {
      title: 'Quản lý ga', noun: 'ga',
      columns: ['Mã ga', 'Tên ga', 'Thành phố', 'Trạng thái', 'Thao tác'],
      values: row => [row.code, row.name, row.city, active(row)]
    },
    trains: {
      title: 'Quản lý đoàn tàu', noun: 'đoàn tàu',
      columns: ['Mã tàu', 'Tên tàu', 'Trạng thái', 'Thao tác'],
      values: row => [row.code, row.name, active(row)]
    },
    trips: {
      title: 'Quản lý chuyến', noun: 'chuyến tàu', statuses: tripStatuses,
      columns: ['Mã chuyến', 'Đoàn tàu', 'Hành trình', 'Khởi hành', 'Đến nơi', 'Giá từ', 'Trạng thái', 'Thao tác'],
      values: row => [row.code, row.train_code, row.origin_name + ' → ' + row.destination_name,
        formatTime(row.departure_at), formatTime(row.arrival_at), money(row.base_price), statuses[row.status]]
    },
    bookings: {
      title: 'Quản lý đơn', statuses: bookingStatuses,
      columns: ['Mã đơn', 'Khách hàng', 'Chuyến', 'Tạo lúc', 'Tổng tiền', 'Trạng thái', 'Thao tác'],
      values: row => [row.code, row.full_name, row.trip_code, formatTime(row.created_at),
        money(row.total_amount), statuses[row.status]]
    },
    users: {
      title: 'Quản lý tài khoản',
      columns: ['Họ tên', 'Email', 'Vai trò', 'Trạng thái', 'Thao tác'],
      values: row => [row.full_name, row.email, row.role === 'ADMIN' ? 'Quản trị viên' : 'Khách hàng', active(row)]
    }
  };
  let resource = 'stations';
  let page = 1;
  let pages = 0;
  let editing = null;
  let busy = false;
  let filter = new URLSearchParams();

  function updateControls() {
    for (const button of workspace.querySelectorAll('button')) button.disabled = busy;
    get('catalog-prev').disabled = busy || page <= 1;
    get('catalog-next').disabled = busy || page >= pages;
  }

  async function run(task) {
    if (busy) return;
    busy = true;
    updateControls();
    try {
      await task();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        workspace.hidden = true;
        get('admin-login').hidden = false;
        closeEditor();
        get('catalog-rows').replaceChildren();
        get('stat-metrics').hidden = true;
        get('daily-table').hidden = true;
      } else if (workspace.hidden) {
        get('admin-retry').hidden = false;
      }
      status(notice, error.message, 'error');
      notice.focus();
    } finally {
      busy = false;
      updateControls();
    }
  }

  function dateQuery(from, to) {
    const query = new URLSearchParams();
    const start = get(from).value;
    const end = get(to).value;
    if (start && end && start > end) throw new Error('Ngày kết thúc phải từ ngày bắt đầu trở đi.');
    if (start) query.set('from', start);
    if (end) query.set('to', end);
    return query;
  }

  async function loadStatistics() {
    const query = dateQuery('stats-from', 'stats-to');
    const data = await request('/api/admin/statistics?' + query);
    for (const key of ['total', 'pending', 'paid', 'cancelled', 'expired', 'tickets']) {
      get('stat-' + key).textContent = String(data[key]);
    }
    get('stat-revenue').textContent = money(data.revenue);
    get('stat-metrics').hidden = false;
    tableRows(get('daily-rows'), data.daily.map(row => [row.day, row.payments, money(row.revenue)]));
    get('daily-table').hidden = data.daily.length === 0;
  }

  function action(label, onClick) {
    const button = document.createElement('button');
    button.className = 'secondary-button';
    button.type = 'button';
    button.textContent = label;
    button.disabled = busy;
    button.addEventListener('click', onClick);
    return button;
  }

  function rowActions(row) {
    const wrap = document.createElement('div');
    if (resource === 'bookings') {
      const link = document.createElement('a');
      link.className = 'feature-back';
      link.href = 'booking.html?booking_id=' + row.id;
      link.textContent = 'Xem đơn';
      wrap.append(link);
    } else if (resource === 'users') {
      if (row.role === 'CUSTOMER') {
        wrap.append(action(row.is_active ? 'Khóa' : 'Mở khóa', () => changeAccount(row)));
      }
    } else {
      const protectedTrip = resource === 'trips' && row.has_bookings;
      if (protectedTrip) {
        wrap.textContent = 'Đã có đơn';
      } else {
        wrap.append(action('Sửa', () => run(() => showEditor(row))),
          action('Xóa', () => remove(row)));
      }
    }
    return wrap;
  }

  async function loadCatalog(wantedPage) {
    const query = new URLSearchParams(filter);
    query.set('page', wantedPage);
    const result = await request('/api/admin/' + resource + '?' + query);
    if (wantedPage > result.total_pages && wantedPage > 1) {
      return loadCatalog(Math.max(1, result.total_pages));
    }
    page = result.page;
    pages = result.total_pages;
    get('catalog-count').textContent = result.total ? 'Tìm thấy ' + result.total + ' bản ghi.' : 'Chưa có dữ liệu phù hợp.';
    get('catalog-page').textContent = pages ? 'Trang ' + page + '/' + pages : '';
    tableRows(get('catalog-rows'), result.items.map(row => [...definitions[resource].values(row), rowActions(row)]));
  }

  function closeEditor() {
    editor.hidden = true;
    get('editor-fields').replaceChildren();
    editing = null;
  }

  function option(value, label) {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = label;
    return item;
  }

  function configureCatalog() {
    const spec = definitions[resource];
    get('catalog-title').textContent = spec.title;
    get('new-item').hidden = !spec.noun;
    get('catalog-count').textContent = '';
    get('catalog-rows').replaceChildren();
    get('catalog-page').textContent = '';
    for (const button of tabs) button.setAttribute('aria-pressed', String(button.dataset.resource === resource));
    for (const id of ['admin-status-filter', 'admin-from-filter', 'admin-to-filter']) get(id).hidden = !spec.statuses;
    get('status-filter').replaceChildren(option('', 'Tất cả'),
      ...(spec.statuses ?? []).map(value => option(value, statuses[value])));
    get('catalog-columns').replaceChildren(...spec.columns.map(label => {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      return cell;
    }));
  }

  function createField(name, label, value, settings = {}) {
    const wrap = document.createElement('div');
    const caption = document.createElement('label');
    const input = document.createElement(settings.options ? 'select' : 'input');
    wrap.className = 'trip-field';
    input.name = name;
    input.id = 'catalog-edit-' + name;
    input.required = true;
    caption.htmlFor = input.id;
    caption.textContent = label;
    if (settings.options) {
      input.replaceChildren(...settings.options.map(([id, title]) => option(id, title)));
    } else {
      input.type = settings.type ?? 'text';
      if (settings.maxLength) input.maxLength = settings.maxLength;
      if (input.type === 'number') {
        input.min = '0';
        input.max = '1000000000';
        input.step = '1';
      }
      if (input.type === 'datetime-local') input.step = '1';
    }
    input.value = value ?? '';
    wrap.append(caption, input);
    get('editor-fields').append(wrap);
  }

  function vietnamInput(value) {
    if (!value) return '';
    return new Date(Date.parse(value) + 7 * 3600000).toISOString().slice(0, 19);
  }

  async function showEditor(row = null) {
    closeEditor();
    const spec = definitions[resource];
    const options = resource === 'trips' ? await request('/api/admin/catalog') : null;
    editing = row;
    get('editor-title').textContent = (row ? 'Sửa ' : 'Thêm ') + spec.noun;
    createField('code', 'Mã', row?.code, { maxLength: resource === 'trips' ? 30 : 10 });
    if (options) {
      const choices = values => [['', 'Chọn…'], ...values.map(item => [item.id, item.code + ' · ' + item.name])];
      createField('train_id', 'Đoàn tàu', row?.train_id, { options: choices(options.trains) });
      createField('origin_id', 'Ga đi', row?.origin_id, { options: choices(options.stations) });
      createField('destination_id', 'Ga đến', row?.destination_id, { options: choices(options.stations) });
      createField('departure_at', 'Khởi hành (giờ Việt Nam)', vietnamInput(row?.departure_at), { type: 'datetime-local' });
      createField('arrival_at', 'Đến nơi (giờ Việt Nam)', vietnamInput(row?.arrival_at), { type: 'datetime-local' });
      createField('base_price', 'Giá vé cơ bản (đồng)', row?.base_price, { type: 'number' });
      createField('status', 'Trạng thái', row?.status ?? 'OPEN', {
        options: tripStatuses.map(value => [value, statuses[value]])
      });
    } else {
      createField('name', 'Tên', row?.name, { maxLength: 100 });
      if (resource === 'stations') createField('city', 'Thành phố', row?.city, { maxLength: 100 });
      createField('is_active', 'Trạng thái', row?.is_active === false ? 'false' : 'true', {
        options: [['true', 'Hoạt động'], ['false', 'Ngừng hoạt động']]
      });
    }
    editor.hidden = false;
    get('catalog-edit-code').focus();
  }

  function remove(row) {
    if (busy || !window.confirm('Xóa ' + definitions[resource].noun + ' ' + row.code + '?')) return;
    run(async () => {
      status(notice, 'Đang xóa…', 'loading');
      await request('/api/admin/' + resource + '/' + row.id, { method: 'DELETE', body: {} });
      if (editing?.id === row.id) closeEditor();
      await loadCatalog(page);
      status(notice, 'Đã xóa ' + row.code + '.', 'success');
    });
  }

  function changeAccount(row) {
    const verb = row.is_active ? 'Khóa' : 'Mở khóa';
    if (busy || !window.confirm(verb + ' tài khoản ' + row.email + '?')) return;
    run(async () => {
      status(notice, 'Đang cập nhật tài khoản…', 'loading');
      await request('/api/admin/users/' + row.id, { method: 'PATCH', body: { is_active: !row.is_active } });
      await loadCatalog(page);
      status(notice, 'Đã cập nhật trạng thái tài khoản.', 'success');
    });
  }

  get('statistics-form').addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      status(notice, 'Đang tải thống kê…', 'loading');
      await loadStatistics();
      status(notice, '');
    });
  });
  get('catalog-search').addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      filter = definitions[resource].statuses ? dateQuery('catalog-from', 'catalog-to') : new URLSearchParams();
      filter.set('keyword', get('admin-keyword').value.trim());
      if (!get('admin-status-filter').hidden) filter.set('status', get('status-filter').value);
      await loadCatalog(1);
      status(notice, '');
    });
  });
  for (const tab of tabs) tab.addEventListener('click', () => run(async () => {
    resource = tab.dataset.resource;
    page = 1;
    pages = 0;
    filter = new URLSearchParams();
    get('catalog-search').reset();
    closeEditor();
    configureCatalog();
    await loadCatalog(1);
    status(notice, '');
  }));
  get('catalog-prev').addEventListener('click', () => run(() => loadCatalog(page - 1)));
  get('catalog-next').addEventListener('click', () => run(() => loadCatalog(page + 1)));
  get('new-item').addEventListener('click', () => run(() => showEditor()));
  get('editor-close').addEventListener('click', closeEditor);
  editor.addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      const body = Object.fromEntries(new FormData(editor));
      if (resource === 'trips') {
        for (const key of ['train_id', 'origin_id', 'destination_id', 'base_price']) body[key] = Number(body[key]);
      } else {
        body.is_active = body.is_active === 'true';
      }
      const id = editing?.id;
      status(notice, 'Đang lưu…', 'loading');
      await request('/api/admin/' + resource + (id ? '/' + id : ''), {
        method: id ? 'PATCH' : 'POST', body
      });
      closeEditor();
      await loadCatalog(id ? page : 1);
      status(notice, 'Đã lưu ' + body.code + '.', 'success');
      notice.focus();
    });
  });

  function initialize() {
    run(async () => {
      get('admin-retry').hidden = true;
      status(notice, 'Đang kiểm tra phiên quản trị…', 'loading');
      const { user } = await request('/api/auth/me');
      if (user?.role !== 'ADMIN') throw Object.assign(new Error('Chức năng này dành cho quản trị viên.'), { status: 403 });
      get('admin-identity').textContent = user.full_name;
      configureCatalog();
      workspace.hidden = false;
      await Promise.all([loadCatalog(1), loadStatistics()]);
      status(notice, '');
    });
  }

  get('admin-retry').addEventListener('click', initialize);
  window.addEventListener('pageshow', event => { if (event.persisted) initialize(); });
  initialize();
})();
