// 1. Lay cac phan tu cua trang trips.html.
const form = document.querySelector('#trip-search-form');
const originSelect = document.querySelector('#origin-id');
const destinationSelect = document.querySelector('#destination-id');
const dateInput = document.querySelector('#departure-date');
const searchButton = document.querySelector('#trip-search-button');
const clearButton = document.querySelector('#trip-clear-button');
const reloadButton = document.querySelector('#trip-reload-button');
const tripsBody = document.querySelector('#trips-body');
const tripCount = document.querySelector('#trip-count');
const statusMessage = document.querySelector('#trip-status');
const prevButton = document.querySelector('#trip-prev-button');
const nextButton = document.querySelector('#trip-next-button');
const pageInfo = document.querySelector('#trip-page-info');

// 2. Cau hinh hien thi va trang thai.
const PAGE_SIZE = 10;
const moneyFormatter = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0
});
const timeFormatter = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

let busy = false;
let stationsReady = false;
let currentPage = 1;
let totalPages = 0;
let activeFilters = { origin_id: '', destination_id: '', date: '' };

function setStatus(message, state) {
  statusMessage.textContent = message;
  statusMessage.dataset.state = state;
}

function updateControls() {
  [originSelect, destinationSelect, dateInput, searchButton, clearButton]
    .forEach((control) => { control.disabled = busy || !stationsReady; });
  reloadButton.disabled = busy;
  reloadButton.textContent = busy ? 'Đang tải...' : 'Tải lại danh sách';
  prevButton.disabled = busy || totalPages === 0 || currentPage <= 1;
  nextButton.disabled = busy || currentPage >= totalPages;
}

function syncFilters() {
  originSelect.value = activeFilters.origin_id;
  destinationSelect.value = activeFilters.destination_id;
  dateInput.value = activeFilters.date;
}

// 3. Goi API va tao danh sach ga.
async function getJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (data.ok !== true) throw new Error('Dữ liệu API không hợp lệ.');
  return data;
}

function fillStations(select, stations, placeholder) {
  const fragment = document.createDocumentFragment();
  const emptyOption = document.createElement('option');
  emptyOption.value = '';
  emptyOption.textContent = placeholder;
  fragment.append(emptyOption);

  stations.forEach((station) => {
    const option = document.createElement('option');
    option.value = String(station.id);
    option.textContent = `${station.name} (${station.code})`;
    fragment.append(option);
  });

  select.replaceChildren(fragment);
}

// 4. Hien thong bao va cac dong chuyen tau.
function showTableMessage(message) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 6;
  cell.textContent = message;
  row.append(cell);
  tripsBody.replaceChildren(row);
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : timeFormatter.format(date);
}

function formatPrice(trip) {
  if (Number(trip.available_seats) <= 0) return 'Hết chỗ';
  if (trip.min_price === null || trip.min_price === undefined) return '—';
  const price = Number(trip.min_price);
  return Number.isFinite(price) && price >= 0 ? moneyFormatter.format(price) : '—';
}

function renderTrips(trips) {
  const fragment = document.createDocumentFragment();

  trips.forEach((trip) => {
    const row = document.createElement('tr');
    const values = [
      trip.code,
      `${trip.origin_name} → ${trip.destination_name}`,
      formatTime(trip.departure_at),
      formatTime(trip.arrival_at),
      trip.available_seats,
      formatPrice(trip)
    ];

    values.forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = value ?? '';
      row.append(cell);
    });

    const trainInfo = document.createElement('small');
    trainInfo.textContent = `Tàu ${trip.train_code}`;
    row.firstElementChild.append(document.createElement('br'), trainInfo);

    if (Number(trip.available_seats) > 0
        && Number.isInteger(trip.id) && trip.id > 0 && trip.id <= 2147483647) {
      const seatLink = document.createElement('a');
      seatLink.href = `seats.html?trip_id=${trip.id}`;
      seatLink.textContent = 'Chọn chỗ';
      seatLink.setAttribute('aria-label', `Chọn chỗ cho chuyến ${trip.code}`);
      seatLink.style.color = 'var(--primary)';
      seatLink.style.textDecoration = 'underline';
      row.firstElementChild.append(document.createElement('br'), seatLink);
    }

    fragment.append(row);
  });

  tripsBody.replaceChildren(fragment);
}

// 5. Gui bo loc va so trang cho Backend.
async function fetchTrips(page) {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(PAGE_SIZE)
  });

  Object.entries(activeFilters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });

  const data = await getJson(`/api/trips?${params.toString()}`);
  if (
    !Array.isArray(data.items)
    || !Number.isInteger(data.total) || data.total < 0
    || data.total_pages !== Math.ceil(data.total / PAGE_SIZE)
  ) {
    throw new Error('Dữ liệu phân trang không hợp lệ.');
  }
  return data;
}

// 6. Tai du lieu, xu ly trang rong va loi.
async function loadPage(page = 1) {
  if (busy) return;
  busy = true;
  currentPage = page;
  totalPages = 0;
  updateControls();
  syncFilters();
  tripCount.textContent = 'Đang tải dữ liệu...';
  pageInfo.textContent = 'Đang tải...';
  setStatus('Đang tải dữ liệu hành trình...', 'loading');
  showTableMessage('Đang tải danh sách chuyến...');

  try {
    if (!stationsReady) {
      const stations = await getJson('/api/stations');
      if (!Array.isArray(stations.items)) {
        throw new Error('Danh sách ga không hợp lệ.');
      }
      fillStations(originSelect, stations.items, 'Tất cả ga đi');
      fillStations(destinationSelect, stations.items, 'Tất cả ga đến');
      stationsReady = true;
      syncFilters();
    }

    let data = await fetchTrips(currentPage);
    while (data.total_pages > 0 && currentPage > data.total_pages) {
      currentPage = data.total_pages;
      data = await fetchTrips(currentPage);
    }

    totalPages = data.total_pages;
    if (totalPages === 0) currentPage = 1;
    tripCount.textContent = `Tìm thấy ${data.total} chuyến`;
    pageInfo.textContent = totalPages > 0
      ? `Trang ${currentPage} / ${totalPages}` : 'Không có trang kết quả';

    if (data.items.length === 0) {
      showTableMessage('Không có chuyến phù hợp.');
      setStatus('Không tìm thấy chuyến. Hãy thử bộ lọc khác.', 'success');
    } else {
      renderTrips(data.items);
      setStatus('Đã tải danh sách chuyến thành công.', 'success');
    }
  } catch (error) {
    console.error('Lỗi tải trang tìm chuyến:', error.message);
    tripCount.textContent = 'Chưa tải được dữ liệu';
    pageInfo.textContent = 'Chưa tải dữ liệu';
    totalPages = 0;
    showTableMessage('Không tải được danh sách chuyến.');
    setStatus(stationsReady
      ? 'Không tải được danh sách chuyến. Vui lòng thử lại.'
      : 'Không tải được danh sách ga. Bấm Tải lại danh sách để thử lại.',
    'error');
  } finally {
    busy = false;
    updateControls();
  }
}

// 7. Tim kiem, xoa bo loc, tai lai va chuyen trang.
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy || !stationsReady || !form.reportValidity()) return;

  if (originSelect.value && originSelect.value === destinationSelect.value) {
    setStatus('Ga đi và ga đến phải khác nhau.', 'error');
    destinationSelect.focus();
    return;
  }

  activeFilters = {
    origin_id: originSelect.value,
    destination_id: destinationSelect.value,
    date: dateInput.value
  };
  loadPage(1);
});

clearButton.addEventListener('click', () => {
  if (busy) return;
  activeFilters = { origin_id: '', destination_id: '', date: '' };
  loadPage(1);
});

reloadButton.addEventListener('click', () => loadPage(currentPage));

prevButton.addEventListener('click', () => {
  if (currentPage > 1) loadPage(currentPage - 1);
});

nextButton.addEventListener('click', () => {
  if (currentPage < totalPages) loadPage(currentPage + 1);
});

// 8. Gioi han ngay va tai du lieu khi mo trang.
dateInput.min = new Date(Date.now() + 7 * 60 * 60 * 1000)
  .toISOString().slice(0, 10);
dateInput.max = '9998-12-31';
loadPage();