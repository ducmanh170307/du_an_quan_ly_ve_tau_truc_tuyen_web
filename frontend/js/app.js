// 1. Lay cac phan tu trong index.html.
const stationsBody = document.querySelector('#stations-body');
const stationCount = document.querySelector('#station-count');
const statusMessage = document.querySelector('#status-message');
const reloadButton = document.querySelector('#reload-button');
const searchForm = document.querySelector('#search-form');
const keywordInput = document.querySelector('#keyword');
const searchButton = document.querySelector('#search-button');
const clearButton = document.querySelector('#clear-button');

// 2. Luu tu khoa da gui va trang thai dang tai.
let currentKeyword = '';
let isLoading = false;

// 3. Cap nhat thong bao va mau trang thai.
function setStatus(message, state) {
  statusMessage.textContent = message;
  statusMessage.dataset.state = state;
}

// 4. Khoa cac dieu khien trong luc cho API.
function setLoading(loading) {
  isLoading = loading;
  reloadButton.disabled = loading;
  searchButton.disabled = loading;
  clearButton.disabled = loading;
  keywordInput.disabled = loading;
  reloadButton.textContent = loading ? 'Đang tải...' : 'Tải lại danh sách';
}

// 5. Hien mot dong thong bao trong bang.
function showTableMessage(message) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');

  cell.colSpan = 4;
  cell.textContent = message;
  row.append(cell);
  stationsBody.replaceChildren(row);
}

// 6. Tao cac dong ga tu du lieu API.
function renderStations(stations) {
  const fragment = document.createDocumentFragment();

  stations.forEach((station, index) => {
    const row = document.createElement('tr');
    const values = [index + 1, station.code, station.name, station.city];

    values.forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = value ?? '';
      row.append(cell);
    });

    fragment.append(row);
  });

  stationsBody.replaceChildren(fragment);
}

// 7. Goi Backend voi tu khoa can tim.
async function loadStations(keyword = '') {
  if (isLoading) return;

  currentKeyword = keyword;
  keywordInput.value = keyword;
  setLoading(true);
  stationCount.textContent = 'Đang tải dữ liệu...';
  setStatus('Đang tải danh sách ga...', 'loading');
  showTableMessage('Đang tải dữ liệu...');

  try {
    const params = new URLSearchParams({ keyword });
    const response = await fetch(`/api/stations?${params.toString()}`, {
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.ok !== true || !Array.isArray(data.items)) {
      throw new Error('Dữ liệu API không hợp lệ.');
    }

    const stations = data.items;
    stationCount.textContent = keyword
      ? `Tìm thấy ${stations.length} ga`
      : `Tổng cộng ${stations.length} ga`;

    if (stations.length === 0) {
      showTableMessage(
        keyword ? 'Không tìm thấy ga phù hợp.' : 'Chưa có ga đang hoạt động.'
      );
      setStatus(
        keyword ? 'Hãy thử từ khóa khác.' : 'Không có dữ liệu để hiển thị.',
        'success'
      );
    } else {
      renderStations(stations);
      setStatus(
        keyword ? 'Đã tìm kiếm ga thành công.' : 'Đã tải danh sách ga thành công.',
        'success'
      );
    }
  } catch (error) {
    console.error('Lỗi tải danh sách ga:', error.message);
    stationCount.textContent = 'Chưa tải được dữ liệu';
    showTableMessage('Không tải được danh sách ga.');
    setStatus('Không tải được danh sách ga. Vui lòng thử lại.', 'error');
  } finally {
    setLoading(false);
  }
}

// 8. Bam Tim kiem hoac nhan Enter trong o nhap.
searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (isLoading) return;

  const keyword = keywordInput.value.trim();

  if (keyword.length > 100) {
    setStatus('Từ khóa tối đa 100 ký tự.', 'error');
    keywordInput.focus();
    return;
  }

  loadStations(keyword);
});

// 9. Xoa bo loc va tai lai ket qua hien tai.
clearButton.addEventListener('click', () => {
  loadStations('');
});

reloadButton.addEventListener('click', () => {
  loadStations(currentKeyword);
});

// 10. Tu dong tai tat ca ga khi mo trang.
loadStations();