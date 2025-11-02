// Safety Monitor - Professional Admin Dashboard
// WebSocket 연결
const socket = io('http://localhost:5000');

// 전역 상태
let currentTheme = getInitialTheme();
let devices = [];
let employees = [];
let wearPolicy = null;
let notifications = [];
let notificationCounter = 0;
let policyBroadcastState = {
    status: 'idle',
    total: 0,
    success: 0,
    failed: 0,
    lastUpdated: null,
    command: null
};
let debugInitialized = false;

function formatKST(dateInput) {
    if (!dateInput) {
        return '정보 없음';
    }

    let dateObj;
    if (dateInput instanceof Date) {
        dateObj = dateInput;
    } else {
        const parsed = new Date(dateInput);
        if (Number.isNaN(parsed.getTime())) {
            return typeof dateInput === 'string' ? dateInput : '정보 없음';
        }
        dateObj = parsed;
    }

    const formatter = new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const parts = formatter.formatToParts(dateObj);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function resolveStateMeta(stateValue) {
    switch (stateValue) {
        case 'CLOSED':
            return { css: 'success', text: '착용' };
        case 'OPEN':
            return { css: 'warning', text: '미착용' };
        default:
            return { css: 'inactive', text: '상태 미확인' };
    }
}

function findEmployeeByIdentifiers(employeeId, deviceId) {
    if (!Array.isArray(employees) || employees.length === 0) {
        return null;
    }

    if (employeeId) {
        const matched = employees.find(emp => emp.id === employeeId);
        if (matched) {
            return matched;
        }
    }

    if (deviceId) {
        const matchedByDevice = employees.find(emp => emp.device_id === deviceId);
        if (matchedByDevice) {
            return matchedByDevice;
        }
    }

    return null;
}

// 초기화
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initNavigation();
    initWebSocket();
    initNotificationCenter();
    loadInitialData();
    updateCurrentTime(); // 시간 업데이트 시작
    setInterval(updateCurrentTime, 1000); // 매초 업데이트
    initLogExportControls();

    const policyForm = document.getElementById('wear-policy-form');
    if (policyForm) {
        policyForm.addEventListener('submit', saveWearPolicy);
    }

    const policyRefreshBtn = document.getElementById('policy-refresh');
    if (policyRefreshBtn) {
        policyRefreshBtn.addEventListener('click', () => loadWearPolicy(true));
    }
});

// 현재 한국 시간 표시
function updateCurrentTime() {
    const now = new Date();
    const kstOffset = 9 * 60; // KST는 UTC+9
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const kstTime = new Date(utcTime + (kstOffset * 60000));
    
    const hours = String(kstTime.getHours()).padStart(2, '0');
    const minutes = String(kstTime.getMinutes()).padStart(2, '0');
    const seconds = String(kstTime.getSeconds()).padStart(2, '0');
    const year = kstTime.getFullYear();
    const month = String(kstTime.getMonth() + 1).padStart(2, '0');
    const day = String(kstTime.getDate()).padStart(2, '0');
    const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
    const weekday = weekdays[kstTime.getDay()];
    
    const timeElement = document.getElementById('currentTime');
    if (timeElement) {
        timeElement.textContent = `${hours}:${minutes}:${seconds} KST`;
    }

    const clockTime = document.getElementById('dashboardClock');
    if (clockTime) {
        clockTime.textContent = `${hours}:${minutes}:${seconds}`;
    }

    const clockDate = document.getElementById('dashboardDate');
    if (clockDate) {
        clockDate.textContent = `${year}-${month}-${day} (${weekday})`;
    }

    const clockMeta = document.getElementById('dashboardClockMeta');
    if (clockMeta) {
        clockMeta.textContent = 'KST • 24h 실시간 동기화';
    }
}

// 테마 관리
function getInitialTheme() {
    // 저장된 설정이 있으면 우선 사용
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
        return savedTheme;
    }
    
    // 저장된 설정이 없으면 시스템 설정 따라가기
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
    }
    
    return 'light';
}

function initTheme() {
    document.documentElement.setAttribute('data-theme', currentTheme);
    updateThemeIcon();
    
    // 시스템 다크모드 변경 감지
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            // 사용자가 수동으로 설정하지 않았을 때만 시스템 설정 따라가기
            if (!localStorage.getItem('theme')) {
                setTheme(e.matches ? 'dark' : 'light');
            }
        });
    }
}

function toggleTheme() {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    setTheme(currentTheme);
}

function setTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    updateThemeIcon();
}

function updateThemeIcon() {
    const icon = document.querySelector('.theme-toggle');
    if (icon) {
        icon.textContent = currentTheme === 'dark' ? '☀' : '🌙';
    }
}

// 알림 센터
function initNotificationCenter() {
    const toggleBtn = document.getElementById('notificationToggle');
    const center = document.getElementById('notificationCenter');

    if (toggleBtn && center) {
        toggleBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const willOpen = !center.classList.contains('open');
            setNotificationCenterOpen(willOpen);
            if (willOpen) {
                updateNotificationIndicator();
            }
        });

        center.addEventListener('click', (event) => {
            event.stopPropagation();
        });
    }

    const clearBtn = document.getElementById('notificationClearAll');
    if (clearBtn) {
        clearBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            clearNotifications();
        });
    }

    const list = document.getElementById('notificationList');
    if (list) {
        list.addEventListener('click', (event) => {
            const dismissBtn = event.target.closest('[data-dismiss]');
            if (!dismissBtn) return;
            const id = Number(dismissBtn.dataset.dismiss);
            if (Number.isFinite(id)) {
                dismissNotification(id);
            }
        });
    }

    document.addEventListener('click', handleNotificationOutsideClick);

    renderNotifications();
}

function handleNotificationOutsideClick(event) {
    const center = document.getElementById('notificationCenter');
    const toggleBtn = document.getElementById('notificationToggle');
    if (!center || !center.classList.contains('open')) {
        return;
    }
    const isInside = center.contains(event.target) || (toggleBtn && toggleBtn.contains(event.target));
    if (!isInside) {
        setNotificationCenterOpen(false);
    }
}

function setNotificationCenterOpen(open) {
    const toggleBtn = document.getElementById('notificationToggle');
    const center = document.getElementById('notificationCenter');
    if (!toggleBtn || !center) return;
    center.classList.toggle('open', open);
    toggleBtn.classList.toggle('active', open);
    updateNotificationIndicator();
}

function renderNotifications() {
    const list = document.getElementById('notificationList');
    if (!list) return;

    if (!notifications.length) {
        list.innerHTML = '<div class="empty-state">표시할 알림이 없습니다.</div>';
    } else {
        const markup = notifications.map(buildNotificationMarkup).join('');
        list.innerHTML = markup;
    }

    updateNotificationIndicator();
}

function buildNotificationMarkup(notification) {
    const timestamp = formatKST(notification.timestamp);
    const icon = getNotificationIcon(notification.type);
    const detailHtml = notification.detail
        ? `<div style="margin-top:6px; font-size:12px; color: var(--text-secondary);">${escapeHtml(notification.detail)}</div>`
        : '';
    const showMessage = notification.message && notification.message !== notification.title;
    let bodyContent = '';
    if (showMessage) {
        bodyContent += `<div>${escapeHtml(notification.message)}</div>`;
    }
    if (detailHtml) {
        bodyContent += detailHtml;
    }
    const messageBlock = bodyContent
        ? `<div class="notification-body">${bodyContent}</div>`
        : '';

    return `
        <div class="notification-card ${notification.type}" data-id="${notification.id}">
            <div class="notification-title">${icon} ${escapeHtml(notification.title)}</div>
            ${messageBlock}
            <div class="notification-meta">
                <span>${timestamp}</span>
                <button class="notification-dismiss" type="button" data-dismiss="${notification.id}">확인</button>
            </div>
        </div>
    `;
}

function dismissNotification(id) {
    notifications = notifications.filter(item => item.id !== id);
    renderNotifications();
}

function clearNotifications() {
    notifications = [];
    renderNotifications();
}

function updateNotificationIndicator() {
    const toggleBtn = document.getElementById('notificationToggle');
    const countEl = document.getElementById('notificationCount');
    const center = document.getElementById('notificationCenter');
    if (countEl) {
        countEl.textContent = `${notifications.length}건`;
    }
    if (toggleBtn) {
        const highlight = notifications.length > 0 && !(center && center.classList.contains('open'));
        toggleBtn.classList.toggle('has-unread', highlight);
    }
}

function getNotificationIcon(type) {
    const icons = {
        success: '✅',
        warning: '⚠️',
        danger: '⛔',
        info: '🔔'
    };
    return icons[type] || icons.info;
}

function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeId(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getMonitoringCardId(containerId, deviceId) {
    return `${containerId}-device-${normalizeId(deviceId)}`;
}

function mapDeviceToMonitoringItem(device, index = 0) {
    const id = device.id || device.device_id || device.address || `device_${index}`;
    const lastData = device.last_data || {};
    return {
        deviceId: id,
        employeeName: lastData.employee_name || device.employee_name || '',
        state: lastData.state || 'OPEN',
        distance: lastData.distance,
        raw: typeof lastData.raw === 'number' ? lastData.raw : lastData.raw ?? '-',
        diff: typeof lastData.diff === 'number' ? lastData.diff : lastData.diff ?? '-',
        timestamp: lastData.timestamp || null,
        connected: Boolean(device.connected),
        nameFallback: device.name || id
    };
}

function mapRealtimeDataToMonitoringItem(data) {
    const deviceId = data.device_id || 'unknown';
    return {
        deviceId,
        employeeName: data.employee_name || '',
        state: data.state || 'OPEN',
        distance: data.distance,
        raw: typeof data.raw === 'number' ? data.raw : data.raw ?? '-',
        diff: typeof data.diff === 'number' ? data.diff : data.diff ?? '-',
        timestamp: data.timestamp || new Date().toISOString(),
        connected: true,
        nameFallback: deviceId
    };
}

function generateMonitoringCard(containerId, item) {
    const stateMeta = resolveStateMeta(item.state);
    const cardId = getMonitoringCardId(containerId, item.deviceId);
    const cardClass = stateMeta.css === 'warning' ? 'device-card unwearing-alert' : 'device-card';
    const displayName = item.employeeName
        ? `${item.employeeName} (${item.deviceId})`
        : item.nameFallback || item.deviceId;
    const connectionText = typeof item.connected === 'boolean'
        ? (item.connected ? '연결됨' : '연결 대기')
        : '정보 없음';
    const distanceText = item.distance === 'ERR' || item.distance == null
        ? '정보 없음'
        : `${item.distance}mm`;
    const rawText = item.raw ?? '-';
    const diffText = item.diff ?? '-';
    const timestampText = item.timestamp ? formatKST(item.timestamp) : '데이터 없음';

    return {
        id: cardId,
        className: cardClass,
        stateCss: stateMeta.css,
        html: `
            <div class="device-header">
                <div class="device-name">
                    <span class="status-dot ${stateMeta.css}"></span>
                    ${escapeHtml(displayName)}
                </div>
                <span class="badge badge-${stateMeta.css}">${stateMeta.text}</span>
            </div>
            <div class="device-info">
                <div class="device-info-item">
                    <span>연결 상태</span>
                    <strong>${escapeHtml(connectionText)}</strong>
                </div>
                <div class="device-info-item">
                    <span>거리</span>
                    <strong>${escapeHtml(distanceText)}</strong>
                </div>
                <div class="device-info-item">
                    <span>홀 센서 RAW</span>
                    <strong>${escapeHtml(rawText)}</strong>
                </div>
                <div class="device-info-item">
                    <span>차이값</span>
                    <strong>${escapeHtml(diffText)}</strong>
                </div>
                <div class="device-info-item">
                    <span>업데이트</span>
                    <strong style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(timestampText)}</strong>
                </div>
            </div>
        `
    };
}

function renderMonitoringGrid(containerId, devicesList) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!Array.isArray(devicesList) || devicesList.length === 0) {
        container.innerHTML = '';
        updateMonitoringEmptyState(containerId, true);
        return;
    }

    const markup = devicesList
        .map(mapDeviceToMonitoringItem)
        .map(item => {
            const card = generateMonitoringCard(containerId, item);
            return `<div id="${card.id}" class="${card.className}" data-device="${escapeHtml(item.deviceId)}" data-state="${card.stateCss}">${card.html}</div>`;
        })
        .join('');

    container.innerHTML = markup;
    updateMonitoringEmptyState(containerId, false);
}

function updateMonitoringEmptyState(containerId, isEmpty) {
    const emptyMap = {
        'dashboard-monitoring': 'dashboard-monitoring-empty',
        'monitoring-grid': 'monitoring-empty'
    };
    const emptyEl = emptyMap[containerId] ? document.getElementById(emptyMap[containerId]) : null;
    if (emptyEl) {
        emptyEl.style.display = isEmpty ? 'block' : 'none';
    }
}

function refreshMonitoringCard(containerId, item) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const cardData = generateMonitoringCard(containerId, item);
    let card = document.getElementById(cardData.id);

    if (!card) {
        card = document.createElement('div');
        card.id = cardData.id;
        container.appendChild(card);
    }

    card.className = cardData.className;
    card.dataset.device = item.deviceId;
    card.dataset.state = cardData.stateCss;
    card.innerHTML = cardData.html;

    updateMonitoringEmptyState(containerId, false);

    if (cardData.stateCss === 'warning') {
        container.prepend(card);
    } else {
        container.appendChild(card);
    }
}

// 네비게이션
function initNavigation() {
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const pageName = link.dataset.page;
            navigateTo(pageName);
        });
    });
}

function navigateTo(pageName) {
    // 모든 페이지 숨기기
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    
    // 모든 네비게이션 활성화 제거
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active');
    });
    
    // 선택한 페이지 표시
    const page = document.getElementById(`${pageName}-page`);
    if (page) {
        page.classList.add('active');
    }
    
    // 네비게이션 활성화
    const activeLink = document.querySelector(`[data-page="${pageName}"]`);
    if (activeLink) {
        activeLink.classList.add('active');
    }
    
    // 페이지 타이틀 업데이트
    const titles = {
        'dashboard': '대시보드',
        'monitoring': '실시간 모니터링',
        'employees': '직원 관리',
        'devices': '디바이스 현황',
        'debug': '디버그 제어',
        'logs': '이력 조회',
        'settings': '설정'
    };
    document.getElementById('pageTitle').textContent = titles[pageName] || '대시보드';
    
    // 페이지별 데이터 로드
    loadPageData(pageName);
}

function loadPageData(pageName) {
    switch(pageName) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'monitoring':
            loadMonitoring();
            break;
        case 'employees':
            loadEmployees();
            break;
        case 'devices':
            loadDevices();
            break;
        case 'debug':
            loadDebugTools();
            break;
        case 'logs':
            loadLogs();
            break;
        case 'settings':
            loadWearPolicy();
            break;
    }
}

// WebSocket 이벤트
function initWebSocket() {
    socket.on('connect', () => {
        updateConnectionStatus(true);
        console.log('Connected to server');
    });

    socket.on('disconnect', () => {
        updateConnectionStatus(false);
        console.log('Disconnected from server');
    });

    socket.on('device_data', (data) => {
        handleDeviceData(data);
    });

    socket.on('state_change', (data) => {
        handleStateChange(data);
    });

    socket.on('device_connected', (data) => {
        const label = data.name || data.device_id || '알 수 없음';
        const detailParts = [label];
        if (data.device_id) {
            detailParts.push(`ID ${data.device_id}`);
        }
        if (data.address) {
            detailParts.push(data.address);
        }
        showNotification(`기기 연결됨`, 'success', {
            title: '기기 연결',
            detail: detailParts.join(' · '),
            deviceId: data.device_id
        });
        loadDevices();
    });

    socket.on('device_disconnected', (data) => {
        const detailParts = [];
        if (data.device_id) {
            detailParts.push(`기기 ${data.device_id}`);
        }
        if (data.error) {
            detailParts.push(data.error);
        }
        showNotification(`기기 연결 해제`, 'warning', {
            title: '기기 연결 해제',
            detail: detailParts.join(' · ') || '연결이 종료되었습니다.',
            deviceId: data.device_id,
            autoOpen: true
        });
        loadDevices();
    });
    
    socket.on('device_status', (data) => {
        updateDeviceStatus(data);
        if (['connected', 'ready', 'disconnected', 'error'].includes(data.status)) {
            loadDevices();
            loadDevicesForMonitoring();
        }
    });

    socket.on('policy_push_summary', (data) => {
        handlePolicyPushSummary(data);
    });

    socket.on('policy_push_result', (data) => {
        handlePolicyPushResult(data);
    });

    socket.on('system_reset', (data) => {
        handleSystemReset(data);
    });
}

function updateDeviceStatus(data) {
    const deviceCard = document.querySelector(`[data-device-id="${data.device_id}"]`);
    if (!deviceCard) return;
    
    let statusBadge = deviceCard.querySelector('.device-status-badge');
    if (!statusBadge) {
        statusBadge = document.createElement('div');
        statusBadge.className = 'device-status-badge';
        deviceCard.appendChild(statusBadge);
    }
    
    const statusIcons = {
        'connecting': '🔄',
        'connected': '✅',
        'ready': '✅',
        'disconnected': '⚠️',
        'reconnecting': '🔄',
        'error': '❌'
    };
    
    const statusColors = {
        'connecting': '#3b82f6',
        'connected': '#10b981',
        'ready': '#10b981',
        'disconnected': '#f59e0b',
        'reconnecting': '#3b82f6',
        'error': '#ef4444'
    };
    
    statusBadge.innerHTML = `
        <div style="padding: 8px 12px; background: ${statusColors[data.status]}20; border-left: 3px solid ${statusColors[data.status]}; border-radius: 4px; margin-top: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 16px;">${statusIcons[data.status]}</span>
                <span style="font-size: 13px; color: ${statusColors[data.status]}; font-weight: 600;">${data.message}</span>
            </div>
            <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">
                ${formatKST(data.timestamp)}
            </div>
        </div>
    `;
}

function handlePolicyPushSummary(data = {}) {
    const total = Number.isFinite(Number(data.total)) ? Number(data.total) : 0;
    policyBroadcastState.total = total;
    policyBroadcastState.command = data.command || policyBroadcastState.command;
    policyBroadcastState.lastUpdated = data.timestamp ? new Date(data.timestamp) : new Date();

    if (data.status === 'started') {
        policyBroadcastState.status = total > 0 ? 'in-progress' : 'completed';
        policyBroadcastState.success = 0;
        policyBroadcastState.failed = 0;

        const statusText = total > 0
            ? `전파 중 • 완료 0/${total}`
            : '전파할 연결된 기기가 없습니다.';

        renderPolicySummary({
            timestamp: policyBroadcastState.lastUpdated,
            status: statusText
        });

        const detail = total > 0
            ? `대상 기기 ${total}대`
            : '연결된 기기가 없어 전파가 즉시 종료되었습니다.';

        showNotification(
            total > 0 ? '착용 정책 전파를 시작했습니다.' : '착용 정책을 저장했지만 전파할 기기가 없습니다.',
            total > 0 ? 'info' : 'warning',
            {
                title: '정책 전파',
                detail
            }
        );

        return;
    }

    if (data.status === 'completed') {
        policyBroadcastState.status = 'completed';
        policyBroadcastState.success = Number.isFinite(Number(data.success))
            ? Number(data.success)
            : policyBroadcastState.success;
        policyBroadcastState.failed = Number.isFinite(Number(data.failed))
            ? Number(data.failed)
            : policyBroadcastState.failed;

        const statusText = total === 0
            ? '전파할 연결된 기기가 없습니다.'
            : `전파 완료 • 성공 ${policyBroadcastState.success} / 실패 ${policyBroadcastState.failed}`;

        renderPolicySummary({
            timestamp: policyBroadcastState.lastUpdated,
            status: statusText
        });

        const hasFailure = policyBroadcastState.failed > 0;
        showNotification('착용 정책 전파가 완료되었습니다.', hasFailure ? 'warning' : 'success', {
            title: '정책 전파',
            detail: statusText,
            autoOpen: hasFailure
        });
    }
}

function handlePolicyPushResult(data = {}) {
    policyBroadcastState.lastUpdated = data.timestamp ? new Date(data.timestamp) : new Date();
    if (policyBroadcastState.status !== 'in-progress') {
        policyBroadcastState.status = 'in-progress';
    }

    const success = Boolean(data.success);
    if (success) {
        policyBroadcastState.success += 1;
    } else {
        policyBroadcastState.failed += 1;
    }

    const detailParts = [];
    if (data.device_id) {
        detailParts.push(`기기 ${data.device_id}`);
    }
    if (data.error) {
        detailParts.push(data.error);
    } else if (!success && data.connected === false) {
        detailParts.push('현재 기기가 연결되어 있지 않습니다.');
    }

    const message = success
        ? '정책 명령을 장치로 전송했습니다.'
        : '정책 명령 전송에 실패했습니다.';
    const title = success ? '정책 전파 성공' : '정책 전파 실패';

    showNotification(message, success ? 'success' : 'danger', {
        title,
        detail: detailParts.join(' · ') || undefined,
        deviceId: data.device_id,
        autoOpen: !success
    });

    if (policyBroadcastState.total > 0) {
        const progress = Math.min(policyBroadcastState.success + policyBroadcastState.failed, policyBroadcastState.total);
        renderPolicySummary({
            timestamp: policyBroadcastState.lastUpdated,
            status: `전파 중 • 완료 ${progress}/${policyBroadcastState.total}`
        });
    } else {
        renderPolicySummary({ timestamp: policyBroadcastState.lastUpdated });
    }
}

function handleSystemReset(data = {}) {
    policyBroadcastState = {
        status: 'idle',
        total: 0,
        success: 0,
        failed: 0,
        lastUpdated: data.timestamp ? new Date(data.timestamp) : new Date(),
        command: null
    };

    showNotification('시스템이 초기화되었습니다. 데이터를 다시 불러옵니다.', 'warning', {
        title: '시스템 초기화',
        detail: formatKST(policyBroadcastState.lastUpdated)
    });

    renderPolicySummary({ timestamp: policyBroadcastState.lastUpdated, status: '정책 정보를 다시 불러오는 중입니다.' });
    loadInitialData();
}

function updateConnectionStatus(connected) {
    const statusEl = document.getElementById('wsStatus');
    if (!statusEl) return;
    statusEl.textContent = connected ? '연결됨' : '연결 끊김';
    statusEl.className = connected ? 'chip online' : 'chip offline';
}

function handleDeviceData(data) {
    // 모니터링 페이지 업데이트
    updateMonitoringDisplay(data);
}

function handleStateChange(data) {
    const isUnwear = data.new_state === 'OPEN';
    const notifyUnwear = document.getElementById('notify-unwear')?.checked !== false;
    const employee = findEmployeeByIdentifiers(data.employee_id, data.device_id);

    if (isUnwear && notifyUnwear) {
        const detailParts = [];
        if (employee) {
            detailParts.push(`${employee.name}${employee.employee_number ? ` (${employee.employee_number})` : ''}`);
            if (employee.department) {
                detailParts.push(employee.department);
            }
        }
        detailParts.push(`기기 ${data.device_id}`);

        showNotification('착용 해제 감지', 'warning', {
            title: '착용 해제 감지',
            detail: detailParts.join(' · '),
            deviceId: data.device_id,
            employee,
            timestamp: data.timestamp
        });
    }

    loadStats();

    if (document.getElementById('logs-page').classList.contains('active')) {
        loadLogs();
    }
}

// 초기 데이터 로드
async function loadInitialData() {
    await Promise.all([
        loadDashboard(),
        loadDevices(),
        loadEmployees(),
        loadWearPolicy()
    ]);
}

// 대시보드
async function loadDashboard() {
    await Promise.all([
        loadStats(),
        loadDevicesForMonitoring()
    ]);
}

async function loadStats() {
    try {
        const [summaryRes, devicesRes, unwearRes] = await Promise.all([
            fetch('/api/stats/summary'),
            fetch('/api/devices'),
            fetch('/api/stats/unwearing')
        ]);

        const summary = await summaryRes.json();
        const devicesData = await devicesRes.json();
        const unwearData = await unwearRes.json();

        const totalEmployeesEl = document.getElementById('stat-total-employees');
        if (totalEmployeesEl) {
            totalEmployeesEl.textContent = summary.total_employees ?? 0;
        }

        const totalDevicesEl = document.getElementById('stat-total-devices');
        if (totalDevicesEl) {
            totalDevicesEl.textContent = Array.isArray(devicesData.devices) ? devicesData.devices.length : 0;
        }

        const offlineCount = Array.isArray(devicesData.devices)
            ? devicesData.devices.filter(device => !device.connected).length
            : 0;
        const offlineEl = document.getElementById('stat-devices-offline');
        if (offlineEl) {
            offlineEl.textContent = offlineCount;
        }

        const nonwearCount = Array.isArray(unwearData.unwearing) ? unwearData.unwearing.length : 0;
        const nonwearEl = document.getElementById('stat-nonwearing');
        if (nonwearEl) {
            nonwearEl.textContent = nonwearCount;
        }
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

async function loadRecentEvents() {
    try {
        const res = await fetch('/api/logs/events?limit=10');
        const data = await res.json();
        
        const container = document.getElementById('recent-events');
        if (!data.logs || data.logs.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">최근 이벤트가 없습니다</p>';
            return;
        }
        
        container.innerHTML = data.logs.map(log => {
            const eventText = log.event_type === 'wear_on' ? '착용' : '착용 해제';
            const severity = log.event_type === 'wear_on' ? 'info' : 'warning';
            const time = formatKST(log.timestamp);
            const employeeName = log.employee_name || '미배정';
            
            return `
                <div class="log-entry ${severity}">
                    <div class="log-time">${time}</div>
                    <div class="log-message">
                        <strong>${employeeName}</strong> - ${eventText} (${log.device_id})
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Failed to load recent events:', error);
    }
}

async function loadCurrentStatus() {
    try {
        const res = await fetch('/api/stats/unwearing');
        const data = await res.json();
        
        const container = document.getElementById('current-status');
        if (!data.unwearing || data.unwearing.length === 0) {
            container.innerHTML = '<p style="color: var(--success); text-align: center;">✓ 모든 직원이 안전장비를 착용하고 있습니다</p>';
            return;
        }
        
        container.innerHTML = data.unwearing.map(emp => {
            const lastUnwearTime = emp.last_unwear_time 
                ? formatKST(emp.last_unwear_time)
                : '정보 없음';
            
            return `
                <div class="device-card" style="border-left: 3px solid var(--warning);">
                    <div class="device-header">
                        <div class="device-name">
                            <span class="status-dot inactive"></span>
                            ${emp.name} (${emp.employee_number})
                        </div>
                        <span class="badge badge-warning">미착용</span>
                    </div>
                    <div style="font-size: 13px; color: var(--text-secondary); margin-top: 8px;">
                        ${emp.department || '부서 미지정'} | 기기: ${emp.device_id}
                    </div>
                    ${emp.last_unwear_time ? `
                    <div style="font-size: 12px; color: var(--warning); margin-top: 4px;">
                        마지막 착용 해제: ${lastUnwearTime}
                    </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Failed to load current status:', error);
    }
}

// 모니터링 페이지
async function loadMonitoring() {
    await loadUnwearLogs();
    await loadDevicesForMonitoring();
    // 실시간 모니터링 그리드는 device_data 이벤트로 업데이트됨
}

async function loadDevicesForMonitoring() {
    try {
        const res = await fetch('/api/devices');
        const data = await res.json();
        const devicesForView = Array.isArray(data.devices) ? data.devices : [];

        const sortedDevices = [...devicesForView].sort((a, b) => {
            const stateA = a?.last_data?.state || '';
            const stateB = b?.last_data?.state || '';
            if (stateA === 'OPEN' && stateB !== 'OPEN') return -1;
            if (stateA !== 'OPEN' && stateB === 'OPEN') return 1;
            const nameA = (a?.last_data?.employee_name || a?.employee_name || a?.name || '').toString();
            const nameB = (b?.last_data?.employee_name || b?.employee_name || b?.name || '').toString();
            return nameA.localeCompare(nameB);
        });

        renderMonitoringGrid('monitoring-grid', sortedDevices);
        renderMonitoringGrid('dashboard-monitoring', sortedDevices);
    } catch (error) {
        console.error('Failed to load devices:', error);
    }
}

function updateMonitoringDisplay(data) {
    const item = mapRealtimeDataToMonitoringItem(data);
    refreshMonitoringCard('monitoring-grid', item);
    refreshMonitoringCard('dashboard-monitoring', item);
}

async function loadUnwearLogs() {
    try {
        const res = await fetch('/api/logs/events?type=wear_off&limit=20');
        const data = await res.json();
        
        const container = document.getElementById('unwear-logs');
        if (!data.logs || data.logs.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">착용 해제 로그가 없습니다</p>';
            return;
        }
        
        container.innerHTML = data.logs.map(log => {
            const time = formatKST(log.timestamp);
            const employeeName = log.employee_name || '미배정';
            
            return `
                <div class="log-entry warning">
                    <div class="log-time">${time}</div>
                    <div class="log-message">
                        <strong>${employeeName}</strong> - ${log.device_id}
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Failed to load unwear logs:', error);
    }
}

// 직원 관리
async function loadEmployees() {
    try {
        const res = await fetch('/api/employees');
        const data = await res.json();
        employees = data.employees || [];
        
        const tbody = document.getElementById('employees-tbody');
        if (employees.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-secondary);">등록된 직원이 없습니다</td></tr>';
            return;
        }
        
        tbody.innerHTML = employees.map(emp => {
            const createdAt = formatKST(emp.created_at).split(' ')[0];
            
            return `
                <tr>
                    <td>${emp.name}</td>
                    <td>${emp.employee_number}</td>
                    <td>${emp.department || '-'}</td>
                    <td>${emp.position || '-'}</td>
                    <td>${emp.device_id || '<span style="color: var(--text-secondary)">미할당</span>'}</td>
                    <td>${createdAt}</td>
                    <td>
                        <button class="btn btn-sm btn-primary" onclick="editEmployee(${emp.id})">수정</button>
                        <button class="btn btn-sm btn-danger" onclick="deleteEmployee(${emp.id})">삭제</button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        console.error('Failed to load employees:', error);
    }
}

function openEmployeeModal(employeeId = null) {
    const modal = document.getElementById('employee-modal');
    const form = document.getElementById('employee-form');
    form.reset();
    
    if (employeeId) {
        // 수정 모드
        const employee = employees.find(e => e.id === employeeId);
        if (employee) {
            document.getElementById('employee-modal-title').textContent = '직원 정보 수정';
            document.getElementById('employee-id').value = employee.id;
            document.getElementById('employee-name').value = employee.name;
            document.getElementById('employee-number').value = employee.employee_number;
            document.getElementById('employee-department').value = employee.department || '';
            document.getElementById('employee-position').value = employee.position || '';
            document.getElementById('employee-device').value = employee.device_id || '';
        }
    } else {
        // 등록 모드
        document.getElementById('employee-modal-title').textContent = '직원 등록';
        document.getElementById('employee-id').value = '';
    }
    
    // 기기 옵션 로드
    loadDeviceOptions();
    
    modal.classList.add('active');
}

function closeEmployeeModal() {
    document.getElementById('employee-modal').classList.remove('active');
}

async function loadDeviceOptions() {
    try {
        const res = await fetch('/api/devices');
        const data = await res.json();
        
        const select = document.getElementById('employee-device');
        select.innerHTML = '<option value="">미할당</option>' +
            data.devices.map(d => `<option value="${d.id}">${d.name} (${d.address})</option>`).join('');
    } catch (error) {
        console.error('Failed to load device options:', error);
    }
}

async function saveEmployee(event) {
    event.preventDefault();
    
    const employeeId = document.getElementById('employee-id').value;
    const payload = {
        name: document.getElementById('employee-name').value,
        employee_number: document.getElementById('employee-number').value,
        department: document.getElementById('employee-department').value,
        position: document.getElementById('employee-position').value,
        device_id: document.getElementById('employee-device').value || null
    };
    
    try {
        let res;
        if (employeeId) {
            // 수정
            res = await fetch(`/api/employees/${employeeId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            // 등록
            res = await fetch('/api/employees', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }
        
        if (res.ok) {
            showNotification(employeeId ? '직원 정보가 수정되었습니다' : '직원이 등록되었습니다', 'success');
            closeEmployeeModal();
            loadEmployees();
            loadStats();
        } else {
            const error = await res.json();
            showNotification(error.error || '저장에 실패했습니다', 'danger');
        }
    } catch (error) {
        showNotification('저장 중 오류가 발생했습니다', 'danger');
        console.error('Failed to save employee:', error);
    }
}

function editEmployee(employeeId) {
    openEmployeeModal(employeeId);
}

async function deleteEmployee(employeeId) {
    if (!confirm('정말 삭제하시겠습니까?')) return;
    
    try {
        const res = await fetch(`/api/employees/${employeeId}`, {
            method: 'DELETE'
        });
        
        if (res.ok) {
            showNotification('직원이 삭제되었습니다', 'success');
            loadEmployees();
            loadStats();
        } else {
            showNotification('삭제에 실패했습니다', 'danger');
        }
    } catch (error) {
        showNotification('삭제 중 오류가 발생했습니다', 'danger');
        console.error('Failed to delete employee:', error);
    }
}

// 기기 관리
async function loadDevices() {
    try {
        const res = await fetch('/api/devices');
        const data = await res.json();
        devices = data.devices || [];
        
        const container = document.getElementById('devices-list');
        if (devices.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">등록된 기기가 없습니다</p>';
            return;
        }
        
        container.innerHTML = devices.map(device => {
            const connected = Boolean(device.connected);
            const connectedClass = connected ? 'success' : 'inactive';
            const connectedText = connected ? '연결됨' : '연결 대기';
            const lastData = device.last_data || {};
            const stateMeta = resolveStateMeta(lastData.state);
            const employeeName = lastData.employee_name || device.employee_name || '-';
            const reconnectBtn = !device.connected 
                ? `<button class="btn btn-sm btn-warning" style="margin-left: 8px;" onclick="reconnectDevice('${device.id}')">재연결</button>`
                : '';
            
            return `
                <div class="device-card${stateMeta.css === 'warning' ? ' unwearing-alert' : ''}" data-device-id="${device.id}">
                    <div class="device-header">
                        <div class="device-name">
                            <span class="status-dot ${connectedClass}"></span>
                            ${device.name}
                        </div>
                        <div>
                            <span class="badge badge-${connectedClass}">${connectedText}</span>
                            ${reconnectBtn}
                            <button class="btn btn-sm btn-danger" style="margin-left: 8px;" onclick="removeDevice('${device.id}')">삭제</button>
                        </div>
                    </div>
                    <div style="font-size: 13px; color: var(--text-secondary); margin-top: 8px;">
                        ${device.address}
                    </div>
                    <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
                        담당자: ${employeeName}
                        ${lastData.state ? ` · 상태: <span style="color: inherit; font-weight: 600;">${stateMeta.text}</span>` : ''}
                    </div>
                </div>
            `;
        }).join('');

        renderPolicySummary();
        updateDebugDeviceOptions();
    } catch (error) {
        console.error('Failed to load devices:', error);
    }
}

async function reconnectDevice(deviceId) {
    try {
        const res = await fetch(`/api/devices/${deviceId}/reconnect`, {
            method: 'POST'
        });
        
        if (res.ok) {
            showNotification('재연결 시도 중...', 'info');
            setTimeout(() => loadDevices(), 2000);
        } else {
            showNotification('재연결 요청에 실패했습니다', 'danger');
        }
    } catch (error) {
        showNotification('재연결 중 오류가 발생했습니다', 'danger');
        console.error('Failed to reconnect device:', error);
    }
}

async function startScan() {
    const scanResults = document.getElementById('scan-results');
    scanResults.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">스캔 중...</p>';
    
    try {
        const res = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timeout: 5 })
        });
        const data = await res.json();
        
        if (!data.devices || data.devices.length === 0) {
            scanResults.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">디바이스를 찾지 못했습니다</p>';
            return;
        }
        
        scanResults.innerHTML = data.devices.map(d => `
            <div class="device-card">
                <div class="device-header">
                    <div class="device-name">${d.name}</div>
                    <button class="btn btn-sm btn-success" onclick="registerDevice('${d.address}', '${d.name}')">등록</button>
                </div>
                <div style="font-size: 13px; color: var(--text-secondary); margin-top: 8px;">
                    ${d.address} | RSSI: ${d.rssi || 'N/A'}
                </div>
            </div>
        `).join('');
    } catch (error) {
        scanResults.innerHTML = '<p style="color: var(--danger);">스캔에 실패했습니다</p>';
        console.error('Scan failed:', error);
    }
}

async function registerDevice(address, name) {
    try {
        const res = await fetch('/api/devices/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, name })
        });
        
        if (res.ok) {
            showNotification(`${name} 등록 및 연결 시도 중`, 'success');
            document.getElementById('scan-results').innerHTML = '';
            setTimeout(() => loadDevices(), 2000);
        } else {
            showNotification('등록에 실패했습니다', 'danger');
        }
    } catch (error) {
        showNotification('등록 중 오류가 발생했습니다', 'danger');
        console.error('Failed to register device:', error);
    }
}

async function removeDevice(deviceId) {
    if (!confirm('기기를 삭제하시겠습니까?')) return;
    
    try {
        const res = await fetch(`/api/devices/${deviceId}`, {
            method: 'DELETE'
        });
        
        if (res.ok) {
            showNotification('기기가 삭제되었습니다', 'success');
            loadDevices();
            loadStats();
        } else {
            showNotification('삭제에 실패했습니다', 'danger');
        }
    } catch (error) {
        showNotification('삭제 중 오류가 발생했습니다', 'danger');
        console.error('Failed to remove device:', error);
    }
}

function resolveDeviceId(device) {
    if (!device) return null;
    return device.id || device.device_id || device.address || null;
}

function loadDebugTools() {
    initDebugControls();
    if (!Array.isArray(devices) || devices.length === 0) {
        loadDevices().then(() => {
            updateDebugDeviceOptions();
            updateDebugDeviceInfo();
        });
    } else {
        updateDebugDeviceOptions();
        updateDebugDeviceInfo();
    }
}

function initDebugControls() {
    if (debugInitialized) return;

    const select = document.getElementById('debug-device-select');
    if (select) {
        select.addEventListener('change', () => {
            updateDebugDeviceInfo();
            updateDebugLastResponse(null);
        });
    }

    const buzzerBeepBtn = document.getElementById('buzzer-beep-btn');
    if (buzzerBeepBtn) buzzerBeepBtn.addEventListener('click', () => sendBuzzerCommand('beep'));
    const buzzerOnBtn = document.getElementById('buzzer-on-btn');
    if (buzzerOnBtn) buzzerOnBtn.addEventListener('click', () => sendBuzzerCommand('on'));
    const buzzerOffBtn = document.getElementById('buzzer-off-btn');
    if (buzzerOffBtn) buzzerOffBtn.addEventListener('click', () => sendBuzzerCommand('off'));
    const buzzerPulseBtn = document.getElementById('buzzer-pulse-btn');
    if (buzzerPulseBtn) buzzerPulseBtn.addEventListener('click', () => sendBuzzerCommand('pulse'));

    const gpioForm = document.getElementById('gpio-command-form');
    if (gpioForm) gpioForm.addEventListener('submit', handleGpioSubmit);

    const debugForm = document.getElementById('debug-command-form');
    if (debugForm) debugForm.addEventListener('submit', handleDebugCommand);

    const debugClear = document.getElementById('debug-command-clear');
    if (debugClear) {
        debugClear.addEventListener('click', () => {
            const input = document.getElementById('debug-command-input');
            if (input) input.value = '';
            updateDebugLastResponse(null);
        });
    }

    debugInitialized = true;
}

function updateDebugDeviceOptions() {
    const select = document.getElementById('debug-device-select');
    if (!select) return;

    const previous = select.value;
    const options = ['<option value="">디바이스를 선택해주세요</option>'];

    (devices || []).forEach(device => {
        const id = resolveDeviceId(device);
        if (!id) return;
        const selected = previous && previous === id ? ' selected' : '';
        const label = escapeHtml(device.name || id);
        const status = device.connected ? '온라인' : '오프라인';
        options.push(`<option value="${escapeHtml(id)}"${selected}>${label} · ${status}</option>`);
    });

    select.innerHTML = options.join('');
    if (previous) {
        select.value = previous;
    }
    if (!select.value && devices && devices.length > 0) {
        const firstId = resolveDeviceId(devices[0]);
        if (firstId) {
            select.value = firstId;
        }
    }

    updateDebugDeviceInfo();
}

function updateDebugDeviceInfo() {
    const info = document.getElementById('debug-device-info');
    if (!info) return;

    const select = document.getElementById('debug-device-select');
    const selectedId = select ? select.value : '';
    if (!selectedId) {
        info.innerHTML = '디바이스를 선택하면 최신 상태와 센서 데이터를 확인할 수 있습니다.';
        updateDebugLastResponse(null);
        return;
    }

    const device = (devices || []).find(item => resolveDeviceId(item) === selectedId);
    if (!device) {
        info.innerHTML = '선택한 디바이스 정보를 찾을 수 없습니다.';
        updateDebugLastResponse(null);
        return;
    }

    const lastData = device.last_data || {};
    const stateMeta = resolveStateMeta(lastData.state || 'OPEN');
    const connectionLabel = device.connected ? '연결됨' : '연결 대기';
    const connectionClass = device.connected ? 'chip online' : 'chip offline';
    const address = device.address ? escapeHtml(device.address) : '정보 없음';
    const name = escapeHtml(device.name || resolveDeviceId(device) || '알 수 없음');
    const employeeName = lastData.employee_name || device.employee_name || '';
    const subtitle = employeeName
        ? `담당자: ${escapeHtml(employeeName)}`
        : `주소: ${address}`;

    let distanceText = '-';
    if (typeof lastData.distance !== 'undefined' && lastData.distance !== null) {
        distanceText = lastData.distance === 'ERR' ? '센서 오류' : `${lastData.distance}mm`;
    }

    const diffText = typeof lastData.diff === 'number' ? lastData.diff : (lastData.diff ?? '-');
    const timestamp = lastData.timestamp ? formatKST(lastData.timestamp) : '데이터 없음';

    info.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px; flex-wrap: wrap;">
            <strong style="font-size:15px; letter-spacing:0.3px;">${name}</strong>
            <span class="${connectionClass}">${connectionLabel}</span>
        </div>
        <div style="margin-top:6px; font-size:12px; color: var(--text-secondary);">${subtitle}</div>
        <div style="margin-top:10px;">상태: <strong>${stateMeta.text}</strong></div>
        <div style="margin-top:4px;">거리: ${distanceText} · Δ: ${diffText}</div>
        <div style="margin-top:4px;">최근 수신: ${timestamp}</div>
    `;
}

function getSelectedDebugDeviceId() {
    const select = document.getElementById('debug-device-select');
    if (!select || !select.value) {
        showNotification('제어할 디바이스를 선택해주세요.', 'warning');
        return null;
    }
    return select.value;
}

function updateDebugLastResponse(payload, success = true) {
    const el = document.getElementById('debug-last-response');
    if (!el) return;

    if (!payload) {
        el.className = 'debug-response';
        el.textContent = '';
        return;
    }

    const timestamp = formatKST(new Date());
    if (success) {
        const message = payload.message ? escapeHtml(payload.message) : '명령이 전송되었습니다.';
        const command = payload.command ? ` · ${escapeHtml(payload.command)}` : '';
        el.className = 'debug-response success';
        el.innerHTML = `${message}${command} · ${timestamp}`;
    } else {
        const errorMsg = payload.error ? escapeHtml(payload.error) : '명령 전송에 실패했습니다.';
        el.className = 'debug-response error';
        el.innerHTML = `${errorMsg} · ${timestamp}`;
    }
}

async function postDeviceCommand(deviceId, endpoint, payload, successMessage) {
    if (!deviceId) return;
    try {
        const res = await fetch(`/api/devices/${deviceId}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        let data = {};
        try {
            data = await res.json();
        } catch (error) {
            data = {};
        }

        if (res.ok) {
            const message = successMessage || data.message || '명령을 전송했습니다.';
            showNotification(message, 'success');
            updateDebugLastResponse(data, true);
            setTimeout(() => loadDevices(), 800);
        } else {
            const errorMsg = data.error || '명령 전송에 실패했습니다.';
            showNotification(errorMsg, 'danger');
            updateDebugLastResponse(data, false);
        }
    } catch (error) {
        console.error('Failed to send command:', error);
        showNotification('명령 전송 중 오류가 발생했습니다.', 'danger');
        updateDebugLastResponse({ error: error.message }, false);
    }
}

async function sendBuzzerCommand(mode) {
    const deviceId = getSelectedDebugDeviceId();
    if (!deviceId) return;

    const payload = { mode };
    const freqField = document.getElementById('buzzer-frequency');
    const freqValue = freqField ? Number(freqField.value) : NaN;
    if (!Number.isNaN(freqValue) && freqValue > 0) {
        payload.frequency_hz = freqValue;
    }

    if (mode === 'pulse') {
        const durationField = document.getElementById('buzzer-pulse-duration');
        const durationValue = durationField ? Number(durationField.value) : NaN;
        if (!Number.isNaN(durationValue) && durationValue > 0) {
            payload.duration_ms = durationValue;
        }
    }

    await postDeviceCommand(deviceId, '/buzzer', payload, '부저 명령을 전송했습니다.');
}

async function handleGpioSubmit(event) {
    event.preventDefault();
    const deviceId = getSelectedDebugDeviceId();
    if (!deviceId) return;

    const pinField = document.getElementById('gpio-pin');
    const stateField = document.getElementById('gpio-state');
    const durationField = document.getElementById('gpio-duration');

    const pinValue = pinField ? Number(pinField.value) : NaN;
    if (Number.isNaN(pinValue)) {
        showNotification('유효한 GPIO 번호를 입력하세요.', 'danger');
        return;
    }

    const payload = {
        pin: pinValue,
        state: stateField ? stateField.value : 'HIGH'
    };

    if (durationField) {
        const durationValue = Number(durationField.value);
        if (!Number.isNaN(durationValue) && durationValue > 0) {
            payload.duration_ms = durationValue;
        }
    }

    await postDeviceCommand(deviceId, '/gpio', payload, 'GPIO 명령을 전송했습니다.');
}

async function handleDebugCommand(event) {
    event.preventDefault();
    const deviceId = getSelectedDebugDeviceId();
    if (!deviceId) return;

    const input = document.getElementById('debug-command-input');
    const command = input ? input.value.trim() : '';
    if (!command) {
        showNotification('전송할 명령을 입력해주세요.', 'warning');
        return;
    }

    await postDeviceCommand(deviceId, '/command', { command }, '명령을 전송했습니다.');
}

// 착용 정책 관리
function renderPolicySummary(meta = {}) {
    if (!wearPolicy) {
        const statusEl = document.getElementById('policy-summary-status');
        if (statusEl) {
            statusEl.textContent = meta.status || '정책 정보를 불러오지 못했습니다.';
        }

        if (meta.timestamp) {
            const updatedEl = document.getElementById('policy-summary-updated');
            if (updatedEl) {
                updatedEl.textContent = formatKST(new Date(meta.timestamp));
            }
        }
        return;
    }

    const enabledEl = document.getElementById('policy-summary-enabled');
    if (enabledEl) {
        const enabled = !!wearPolicy.distance_enabled;
        enabledEl.textContent = enabled ? '활성' : '비활성';
        enabledEl.className = `pill ${enabled ? 'pill-success' : 'pill-muted'}`;
    }

    const closeEl = document.getElementById('policy-summary-close');
    if (closeEl && typeof wearPolicy.distance_close !== 'undefined') {
        closeEl.textContent = `${wearPolicy.distance_close} mm`;
    }

    const openEl = document.getElementById('policy-summary-open');
    if (openEl && typeof wearPolicy.distance_open !== 'undefined') {
        openEl.textContent = `${wearPolicy.distance_open} mm`;
    }

    const updatedEl = document.getElementById('policy-summary-updated');
    if (updatedEl) {
        let timestamp = meta.timestamp ? new Date(meta.timestamp) : null;
        if (!timestamp && policyBroadcastState.lastUpdated) {
            timestamp = new Date(policyBroadcastState.lastUpdated);
        }
        updatedEl.textContent = formatKST(timestamp || new Date());
    }

    const statusEl = document.getElementById('policy-summary-status');
    if (statusEl) {
        if (meta.status) {
            statusEl.textContent = meta.status;
            return;
        }

        if (policyBroadcastState.status === 'in-progress') {
            const progress = `${policyBroadcastState.success + policyBroadcastState.failed}/${policyBroadcastState.total}`;
            statusEl.textContent = `전파 중 • 완료 ${progress}`;
        } else if (policyBroadcastState.status === 'completed') {
            if (policyBroadcastState.total === 0) {
                statusEl.textContent = '전파할 연결된 기기가 없습니다.';
            } else {
                statusEl.textContent = `전파 완료 • 성공 ${policyBroadcastState.success} / 실패 ${policyBroadcastState.failed}`;
            }
        } else {
            statusEl.textContent = '서버 정책과 동기화되었습니다.';
        }
    }
}

async function loadWearPolicy(isManual = false) {
    try {
        const res = await fetch('/api/policy/wear');
        const data = await res.json();
        wearPolicy = data;

        if (policyBroadcastState.status !== 'in-progress') {
            policyBroadcastState = {
                status: 'idle',
                total: 0,
                success: 0,
                failed: 0,
                lastUpdated: new Date(),
                command: null
            };
        } else {
            policyBroadcastState.lastUpdated = new Date();
        }

        const enabledEl = document.getElementById('policy-distance-enabled');
        const closeEl = document.getElementById('policy-distance-close');
        const openEl = document.getElementById('policy-distance-open');
        const statusEl = document.getElementById('policy-status');
        const now = new Date();

        if (enabledEl) enabledEl.checked = !!data.distance_enabled;
        if (closeEl && typeof data.distance_close !== 'undefined') closeEl.value = data.distance_close;
        if (openEl && typeof data.distance_open !== 'undefined') openEl.value = data.distance_open;
        if (statusEl) statusEl.textContent = `불러온 시각: ${formatKST(now)}`;

    const summaryStatus = isManual ? '정책 정보를 다시 불러왔습니다.' : undefined;
    renderPolicySummary({ timestamp: now, status: summaryStatus });

        if (isManual) {
            showNotification('정책 설정을 다시 불러왔습니다.', 'info');
        }
    } catch (error) {
        console.error('Failed to load wear policy:', error);
        showNotification('정책 정보를 불러오지 못했습니다.', 'danger');
    }
}

async function saveWearPolicy(event) {
    event.preventDefault();

    const enabledEl = document.getElementById('policy-distance-enabled');
    const closeEl = document.getElementById('policy-distance-close');
    const openEl = document.getElementById('policy-distance-open');
    const statusEl = document.getElementById('policy-status');

    const distanceEnabled = enabledEl ? enabledEl.checked : true;
    const distanceClose = closeEl ? parseInt(closeEl.value, 10) : (wearPolicy?.distance_close ?? 120);
    const distanceOpen = openEl ? parseInt(openEl.value, 10) : (wearPolicy?.distance_open ?? 160);

    if (Number.isNaN(distanceClose) || Number.isNaN(distanceOpen)) {
        showNotification('유효한 거리 값을 입력하세요.', 'danger');
        return;
    }

    const payload = {
        distance_enabled: distanceEnabled,
        distance_close: distanceClose,
        distance_open: distanceOpen
    };

    try {
        const res = await fetch('/api/policy/wear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            throw new Error('정책 저장 실패');
        }

        const data = await res.json();
        wearPolicy = data.policy;
        const appliedAt = new Date();
        const targets = Number.isFinite(Number(data.targets)) ? Number(data.targets) : 0;

        const commandDescriptor = `DIST_EN=${payload.distance_enabled ? 1 : 0}, CLOSE=${payload.distance_close}, OPEN=${payload.distance_open}`;

        policyBroadcastState = {
            status: targets > 0 ? 'in-progress' : 'completed',
            total: targets,
            success: 0,
            failed: 0,
            lastUpdated: appliedAt,
            command: commandDescriptor
        };

        if (statusEl) {
            statusEl.textContent = `적용 시각: ${formatKST(appliedAt)}`;
        }

        const baseDetail = `거리 판정 ${wearPolicy.distance_enabled ? '활성' : '비활성'} · 착용 ${wearPolicy.distance_close}mm · 미착용 ${wearPolicy.distance_open}mm`;

        const summaryStatus = targets > 0
            ? `전파 중 • 완료 0/${targets}`
            : '전파할 연결된 기기가 없습니다.';

        renderPolicySummary({
            timestamp: appliedAt,
            status: summaryStatus
        });

        if (targets > 0) {
            showNotification('착용 정책을 저장했고 전파를 시작했습니다.', 'info', {
                title: '정책 저장',
                detail: `${baseDetail} · 대상 ${targets}대`
            });
        } else {
            showNotification('착용 정책은 저장되었으나 전파할 연결된 기기가 없습니다.', 'warning', {
                title: '정책 저장',
                detail: baseDetail,
                autoOpen: true
            });
        }
    } catch (error) {
        console.error('Failed to save wear policy:', error);
        showNotification('정책 저장에 실패했습니다.', 'danger');
    }
}

function initLogExportControls() {
    const dateInput = document.getElementById('log-date-input');
    if (dateInput && !dateInput.value) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        dateInput.value = `${year}-${month}-${day}`;
    }

    if (dateInput) {
        dateInput.addEventListener('change', () => loadLogs());
    }

    const exportBtn = document.getElementById('log-export-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportLogs);
    }
}

async function exportLogs() {
    const dateInput = document.getElementById('log-date-input');
    const targetDate = dateInput ? dateInput.value : '';

    if (!targetDate) {
        showNotification('엑셀로 내보낼 날짜를 선택해주세요.', 'warning');
        return;
    }

    try {
        const res = await fetch(`/api/logs/events/export?date=${encodeURIComponent(targetDate)}`);
        if (!res.ok) {
            let message = 'Excel 파일 생성에 실패했습니다.';
            const contentType = res.headers.get('Content-Type') || '';
            if (contentType.includes('application/json')) {
                const body = await res.json().catch(() => ({}));
                if (body.error) {
                    message = body.error;
                }
            }
            showNotification(message, 'danger', { autoOpen: true });
            return;
        }

        const blob = await res.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        const disposition = res.headers.get('Content-Disposition') || '';
        let filename = `event_logs_${targetDate}.xlsx`;
        const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
        if (match && match[1]) {
            try {
                filename = decodeURIComponent(match[1]);
            } catch (error) {
                filename = match[1];
            }
        }

        anchor.href = downloadUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        window.URL.revokeObjectURL(downloadUrl);

        showNotification('지정한 날짜의 로그를 Excel로 다운로드했습니다.', 'success');
    } catch (error) {
        console.error('Failed to export logs:', error);
        showNotification('Excel 다운로드 중 오류가 발생했습니다.', 'danger', { autoOpen: true });
    }
}

// 로그 페이지
async function loadLogs() {
    const typeFilter = document.getElementById('log-type-filter')?.value || '';
    const dateFilter = document.getElementById('log-date-input')?.value || '';
    
    try {
        let url = '/api/logs/events?limit=100';
        if (typeFilter) {
            url += `&type=${encodeURIComponent(typeFilter)}`;
        }
        if (dateFilter) {
            url += `&date=${encodeURIComponent(dateFilter)}`;
        }

        const res = await fetch(url);
        const container = document.getElementById('logs-container');

        if (!res.ok) {
            const errorBody = await res.json().catch(() => ({}));
            const message = errorBody.error || '로그를 불러오는 중 오류가 발생했습니다.';
            if (container) {
                container.innerHTML = `<p style="color: var(--danger); text-align: center;">${escapeHtml(message)}</p>`;
            }
            return;
        }

        const data = await res.json();
        if (!data.logs || data.logs.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">로그가 없습니다</p>';
            return;
        }
        
        container.innerHTML = data.logs.map(log => {
            const time = formatKST(log.timestamp);
            const employeeName = log.employee_name || '미배정';
            const eventText = log.event_type === 'wear_on' ? '착용' : '착용 해제';
            const severity = log.event_type === 'wear_on' ? 'info' : 'warning';
            
            return `
                <div class="log-entry ${severity}">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <div class="log-time">${time}</div>
                            <div class="log-message">
                                <strong>${employeeName}</strong> - ${eventText} | ${log.device_id}
                            </div>
                        </div>
                        <span class="badge badge-${severity}">${log.severity}</span>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Failed to load logs:', error);
    }
}

// 알림 시스템
function showNotification(message, type = 'info', meta = {}) {
    const defaultTitles = {
        success: 'Notice',
        warning: 'Warning',
        danger: 'Alert',
        info: 'Notice'
    };

    const notification = {
        id: ++notificationCounter,
        type,
        title: meta.title || defaultTitles[type] || '알림',
        message,
        detail: meta.detail || '',
        deviceId: meta.deviceId || '',
        employeeName: meta.employee?.name || meta.employeeName || '',
        employeeNumber: meta.employee?.employee_number || meta.employeeNumber || '',
        employeeDepartment: meta.employee?.department || meta.employeeDepartment || '',
        timestamp: meta.timestamp ? new Date(meta.timestamp) : new Date()
    };

    if (!notification.detail) {
        const detailParts = [];
        if (notification.employeeName) {
            const label = notification.employeeNumber
                ? `${notification.employeeName} (${notification.employeeNumber})`
                : notification.employeeName;
            detailParts.push(label);
            if (notification.employeeDepartment) {
                detailParts.push(notification.employeeDepartment);
            }
        }
        if (notification.deviceId) {
            detailParts.push(`Device ${notification.deviceId}`);
        }
        notification.detail = detailParts.join(' · ');
    }

    notifications.unshift(notification);
    if (notifications.length > 30) {
        notifications = notifications.slice(0, 30);
    }

    renderNotifications();

    if (meta.autoOpen || type === 'danger') {
        setNotificationCenterOpen(true);
    }
}

// 로그아웃
async function logout() {
    if (!confirm('로그아웃하시겠습니까?')) return;
    
    try {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login';
    } catch (error) {
        console.error('Logout failed:', error);
        window.location.href = '/login';
    }
}

async function resetDatabase() {
    const confirmationField = document.getElementById('reset-confirmation');
    const confirmationValue = confirmationField ? confirmationField.value.trim().toUpperCase() : '';

    if (confirmationValue !== 'RESET') {
        showNotification('초기화를 진행하려면 RESET을 입력해주세요.', 'warning');
        return;
    }

    if (!confirm('모든 서버 데이터가 삭제됩니다. 계속하시겠습니까?')) {
        return;
    }

    try {
        const res = await fetch('/api/system/reset-db', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: true })
        });

        if (!res.ok) {
            const errorBody = await res.json().catch(() => ({}));
            const message = errorBody.error || '데이터베이스 초기화에 실패했습니다.';
            showNotification(message, 'danger', { autoOpen: true });
            return;
        }

        if (confirmationField) {
            confirmationField.value = '';
        }

        showNotification('데이터베이스 초기화를 요청했습니다. 잠시만 기다려 주세요.', 'info', {
            title: '시스템 초기화'
        });
    } catch (error) {
        console.error('Failed to reset database:', error);
        showNotification('데이터베이스 초기화 중 오류가 발생했습니다.', 'danger', { autoOpen: true });
    }
}

// 모바일 메뉴 토글
function toggleMobileMenu() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('active');
}

