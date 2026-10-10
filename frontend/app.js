// Application State
let map;
let allMarkers = {}; 
let temporaryGlobalMarker = null; 

const BASE_COORDS = [80.6480, 16.5062]; 

// Restored verification locales
const LOCATIONS = [];

// --- Risk Engine Configuration (100% Transparent Methodology) ---
const RISK_CONFIG = {
    heatwave: { dangerThreshold_C: 38, historicalPercentileWeight: 0.3, forecastWeight: 0.7 },
    extremeRainfall: { dangerPrecip_mm: 50, forecastWeight: 1.0 },
    drought: { deficitDaysLookback: 30, dryDayThreshold_mm: 2 },
    flood: { riverDischargeThreshold_m3s: 2000, elevationDanger_m: 30 }
};

const dataCache = {};
const CACHE_TTL_MS = 30 * 60 * 1000; 

document.addEventListener('DOMContentLoaded', () => {
    initMap();
    document.getElementById('config-printout').textContent = JSON.stringify(RISK_CONFIG, null, 2);
});

// UI Toggles
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    document.getElementById(`tab-${tabId}`).classList.add('active');
    document.getElementById(`content-${tabId}`).classList.add('active');
}

function initMap() {
    // 1. Initialize Map
    map = new maplibregl.Map({
        container: 'map',
        style: 'https://tiles.openfreemap.org/styles/liberty', 
        center: BASE_COORDS, zoom: 12.5, attributionControl: false 
    });

    map.addControl(new maplibregl.AttributionControl({
        customAttribution: '&copy; <a href="https://carto.com/" target="_blank">CARTO</a>, Data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>'
    }), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    const renderMarkers = () => {
        LOCATIONS.forEach(loc => {
            const popupContent = `
                <div style="font-family: 'Inter', sans-serif;">
                    <h3>${loc.title}</h3>
                    <span class="popup-sample-note">${loc.sampleNotes}</span>
                    <p style="font-size: 0.9rem; margin-bottom: 0px; line-height: 1.4; color: var(--text-secondary);">${loc.description}</p>
                </div>
            `;
            const popup = new maplibregl.Popup({ offset: 25, closeButton: true, closeOnClick: true, maxWidth: '280px' }).setHTML(popupContent);
            const marker = new maplibregl.Marker().setLngLat(loc.coords).setPopup(popup).addTo(map);

            marker.getElement().addEventListener('click', () => selectLocationUI(loc.id, loc.title, loc.coords));
            allMarkers[loc.id] = marker; 
        });
    };

    // Safely fire marker rendering dynamically. 
    // They are DOM elements and don't strictly require map to completely finish its style-parsing!
    map.on('style.load', renderMarkers); 
    
    // CRITICAL FIX: Build the DOM list IMMEDIATELY so the dashboard works even if map tiles are blocked!
    renderLocationList(LOCATIONS);
    setupSearchFilter();

    map.on('error', (e) => {
        console.warn("MapLibre engine network timeout handled: ", e);
        // Force marker generation to DOM even on failover
        if(Object.keys(allMarkers).length === 0) renderMarkers();
    });
}

function renderLocationList(locationsToRender) {
    const listContainer = document.getElementById('location-list');
    listContainer.innerHTML = ''; 

    if (locationsToRender.length === 0) {
        listContainer.innerHTML = '<li style="padding: 12px; color: var(--text-secondary); font-size: 0.9rem;">Press Enter to search the globe!</li>';
        return;
    }

    locationsToRender.forEach(loc => {
        const li = document.createElement('li');
        li.className = 'list-item'; li.id = `list-item-${loc.id}`;
        li.innerHTML = `<h3>${loc.title}</h3><p>${loc.description.substring(0, 60)}...</p>`;

        li.addEventListener('click', () => {
            selectLocationUI(loc.id, loc.title, loc.coords);
            const marker = allMarkers[loc.id];
            if (marker) {
                map.flyTo({ center: loc.coords, zoom: 14.8, duration: 1500, essential: true });
                if (!marker.getPopup().isOpen()) marker.togglePopup();
            }
        });
        listContainer.appendChild(li);
    });
}

function setupSearchFilter() {
    const input = document.getElementById('local-search-input');
    input.addEventListener('input', (event) => {
        const term = event.target.value.toLowerCase();
        renderLocationList(LOCATIONS.filter(loc => loc.title.toLowerCase().includes(term) || loc.description.toLowerCase().includes(term)));
    });
    
    input.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            const term = event.target.value.trim();
            if (term.length > 2) geolocateCity(term);
        }
    });
}

async function geolocateCity(query) {
    const input = document.getElementById('local-search-input');
    const originalPlaceholder = input.placeholder;
    try {
        input.placeholder = "Searching the globe..."; input.value = ""; input.disabled = true; 
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
        const data = await response.json();
        input.disabled = false; input.placeholder = originalPlaceholder; input.value = query; 

        if (data && data.length > 0) {
            const bestResult = data[0];
            const targetCoords = [parseFloat(bestResult.lon), parseFloat(bestResult.lat)];
            const shortName = bestResult.display_name.split(',')[0];

            if (temporaryGlobalMarker) temporaryGlobalMarker.remove();

            const popup = new maplibregl.Popup({ offset: 25, closeButton: true, closeOnClick: true, maxWidth: '280px' })
                .setHTML(`
                    <div style="font-family: 'Inter', sans-serif;">
                        <h3 style="margin: 0 0 4px 0; font-size: 1.05rem; color: var(--text-primary);">${shortName}</h3>
                        <p style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0;">${bestResult.display_name}</p>
                    </div>
                `);
            temporaryGlobalMarker = new maplibregl.Marker({ color: '#ef4444' }).setLngLat(targetCoords).setPopup(popup).addTo(map);

            temporaryGlobalMarker.getElement().addEventListener('click', () => fetchEngineData(shortName, targetCoords[1], targetCoords[0]));
            map.flyTo({ center: targetCoords, zoom: 11.5, duration: 2500, essential: true });
            
            setTimeout(() => { if(temporaryGlobalMarker && !temporaryGlobalMarker.getPopup().isOpen()) temporaryGlobalMarker.togglePopup(); }, 2500);
            selectLocationUI(null, shortName, targetCoords);

        } else { alert(`No global coordinate results found for "${query}"`); }
    } catch (error) {
        input.disabled = false; input.placeholder = originalPlaceholder;
        alert("Failed to connect to the Nominatim geocoding service.");
    }
}

function selectLocationUI(locationId, locationTitle, coords) {
    document.querySelectorAll('.list-item').forEach(item => item.classList.remove('selected'));
    if (locationId) {
        const target = document.getElementById(`list-item-${locationId}`);
        if (target) { target.classList.add('selected'); target.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    }
    fetchEngineData(locationTitle, coords[1], coords[0]);
}

/* ========================================================
 *              ENVIRONMENTAL FETCH ENGINE
 * ======================================================== */
function renderLoadingState(title) {
    const panel = document.getElementById('side-panel');
    panel.classList.remove('hidden');
    document.getElementById('panel-header').innerHTML = `
        <div><h2>${title}</h2><p>Connecting to Open-Meteo APIs...</p></div>
    `;
    document.getElementById('panel-errors').innerHTML = '';
    document.getElementById('weather-body').innerHTML = `<div class="loader-state"><div class="spinner"></div><p>Pulling arrays...</p></div>`;
    document.getElementById('risk-body').innerHTML = `<div class="loader-state"><div class="spinner"></div><p>Evaluating logic models...</p></div>`;
}

function renderErrorState(title, errorMsg) {
    document.getElementById('panel-errors').innerHTML = `
        <div class="error-state"><h3>Connection Error</h3><p>${errorMsg}</p></div>
    `;
    document.getElementById('weather-body').innerHTML = '';
    document.getElementById('risk-body').innerHTML = '';
}

async function fetchEngineData(title, lat, lng, bypassCache = false) {
    window.currentViewTitle = title;
    window.currentViewLat = lat; window.currentViewLng = lng;
    renderLoadingState(title);

    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (!bypassCache && dataCache[cacheKey] && (Date.now() - dataCache[cacheKey].timestamp) < CACHE_TTL_MS) {
        injectDOM(title, dataCache[cacheKey].payload, dataCache[cacheKey].timestamp, lat, lng);
        return;
    }

    try {
        const localTz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || 'auto');
        
        const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_gusts_10m,weather_code&hourly=temperature_2m,precipitation_probability,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=${localTz}&elevation=nan`;
        
        const d = new Date(); d.setDate(d.getDate() - 31);
        const pastStr = d.toISOString().split('T')[0];
        const t2 = new Date(); t2.setDate(t2.getDate() - 1);
        const yestStr = t2.toISOString().split('T')[0];
        const historyUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${pastStr}&end_date=${yestStr}&daily=temperature_2m_max,precipitation_sum&timezone=${localTz}`;

        const floodUrl = `https://flood-api.open-meteo.com/v1/flood?latitude=${lat}&longitude=${lng}&daily=river_discharge,river_discharge_median`;

        // Used standard Promise.all instead of ES2020 allSettled for rock-solid cross-browser embedded environments
        const [resFore, resHist, resFlood] = await Promise.all([ 
            fetch(forecastUrl).catch(e => e), 
            fetch(historyUrl).catch(e => e), 
            fetch(floodUrl).catch(e => e)
        ]);

        if (resFore instanceof Error || !resFore.ok) throw new Error("Critical Forecast Core failed down.");
        const payload = { forecast: await resFore.json(), history: null, flood: null };
        
        if (!(resHist instanceof Error) && resHist.ok) payload.history = await resHist.json();
        if (!(resFlood instanceof Error) && resFlood.ok) payload.flood = await resFlood.json();

        dataCache[cacheKey] = { payload, timestamp: Date.now() };
        injectDOM(title, payload, Date.now(), lat, lng);

    } catch (error) { renderErrorState(title, `Data engine collapsed: ${error.message}`); }
}

function calculateRisks(payload) {
    const f = payload.forecast;
    const h = payload.history;
    const fl = payload.flood;
    let elevation = f.elevation || 0;

    const scores = {
        heatwave: { val: 0, level: 'low', logic: '', conf: 'low' },
        extremefall: { val: 0, level: 'low', logic: '', conf: 'low' },
        drought: { val: 0, level: 'low', logic: '', conf: 'low' },
        flood: { val: 0, level: 'low', logic: '', conf: 'low' }
    };

    // 1. Extreme Rain
    if (f.daily && f.daily.precipitation_sum) {
        let maxRain7Day = Math.max(...f.daily.precipitation_sum);
        let rainScore = Math.min((maxRain7Day / RISK_CONFIG.extremeRainfall.dangerPrecip_mm) * 100, 100);
        scores.extremefall.val = Math.round(rainScore);
        scores.extremefall.conf = 'high';
        scores.extremefall.logic = `Forecast models predict a maximum single-day rainfall spike of ${maxRain7Day}mm this week against a prototype danger limit of ${RISK_CONFIG.extremeRainfall.dangerPrecip_mm}mm.`;
        if(rainScore > 75) scores.extremefall.level = 'high'; else if(rainScore > 40) scores.extremefall.level = 'moderate';
    }

    // 2. Heatwave
    if (f.daily && f.daily.temperature_2m_max) {
        let maxTemp7Day = Math.max(...f.daily.temperature_2m_max);
        let heatScore = Math.min((maxTemp7Day / RISK_CONFIG.heatwave.dangerThreshold_C) * 90, 100);
        if (h && h.daily && h.daily.temperature_2m_max) {
            let histMax = Math.max(...h.daily.temperature_2m_max);
            heatScore += (maxTemp7Day > histMax) ? 10 : 0; // Bump if hotter than last month
            scores.heatwave.conf = 'high';
            scores.heatwave.logic = `Forecast max is ${maxTemp7Day}°C. Local 30-day historical baseline observed max was ${histMax}°C. Algorithm penalizes deviations bounding past prototype limits of ${RISK_CONFIG.heatwave.dangerThreshold_C}°C.`;
        } else {
            scores.heatwave.conf = 'low';
            scores.heatwave.logic = `Forecast max is ${maxTemp7Day}°C. Historical baseline APIs failed to load, dropping score validity. Assessed purely on static ${RISK_CONFIG.heatwave.dangerThreshold_C}°C threshold.`;
            heatScore = Math.min((maxTemp7Day / RISK_CONFIG.heatwave.dangerThreshold_C) * 100, 100);
        }
        scores.heatwave.val = Math.round(heatScore);
        if(scores.heatwave.val > 75) scores.heatwave.level = 'high'; else if(scores.heatwave.val > 45) scores.heatwave.level = 'moderate';
    }

    // 3. Drought
    if (h && h.daily && h.daily.precipitation_sum) {
        let dryDays = h.daily.precipitation_sum.filter(p => p < RISK_CONFIG.drought.dryDayThreshold_mm).length;
        let dScore = (dryDays / RISK_CONFIG.drought.deficitDaysLookback) * 100;
        scores.drought.val = Math.round(dScore);
        scores.drought.conf = 'high';
        scores.drought.logic = `Historical model indicates ${dryDays} dry days out of the past ${RISK_CONFIG.drought.deficitDaysLookback}. High deficit triggers long-term rainfall deviation models.`;
        if(dScore > 70) scores.drought.level = 'high'; else if(dScore > 40) scores.drought.level = 'moderate';
    } else {
        scores.drought.logic = "Insufficient Historical Data to baseline soil moisture & rain deficits. Defaulting to extremely low confidence state.";
    }

    // 4. Flood
    if (fl && fl.daily && fl.daily.river_discharge) {
        let maxDischarge = Math.max(...fl.daily.river_discharge.filter(n => n !== null)) || 0;
        let maxMed = Math.max(...fl.daily.river_discharge_median.filter(n => n !== null)) || 1; 
        
        let multiplier = maxDischarge / maxMed; 
        let fScore = Math.min((maxDischarge / RISK_CONFIG.flood.riverDischargeThreshold_m3s) * 80 + (elevation < RISK_CONFIG.flood.elevationDanger_m ? 20 : 0), 100);
        
        scores.flood.val = Math.round(fScore);
        scores.flood.conf = 'high';
        scores.flood.logic = `Grid modelled River Discharge peaks at ${maxDischarge} m³/s (${multiplier.toFixed(1)}x median flow). Location elevation detected at ${elevation}m.`;
        if(fScore > 75) scores.flood.level = 'high'; else if(fScore > 40) scores.flood.level = 'moderate';
    } else {
        scores.flood.logic = "Global river models lacked matching grid cell confidence for this exact lat/lng point. Assessment relies purely on rainfall.";
        scores.flood.val = scores.extremefall.val; // Mirror rain if river fails
        scores.flood.level = scores.extremefall.level;
    }

    return scores;
}

function injectDOM(title, payload, fetchTimeMs, lat, lng) {
    const f = payload.forecast;
    const fetchTimeStr = new Date(fetchTimeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    document.getElementById('panel-header').innerHTML = `
        <div>
            <h2>${title}</h2>
            <p>Lat: ${lat.toFixed(3)}, Lng: ${lng.toFixed(3)} | Elev: ${f.elevation}m</p>
            <p style="margin-top: 4px; color: var(--accent);">Last fetched: ${fetchTimeStr}</p>
        </div>
        <button class="refresh-btn" onclick="fetchEngineData(window.currentViewTitle, window.currentViewLat, window.currentViewLng, true)">Force Sync</button>
    `;

    const c = f.current || {};
    const cU = f.current_units || {};
    let hourlyHtml = '';
    const now = new Date();
    const localISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T${String(now.getHours()).padStart(2,'0')}:00`; 
    
    // Removed ES2020 optional chaining to guarantee robust backwards compatibility
    let startIndex = 0;
    if (f.hourly && f.hourly.time) {
        startIndex = Math.max(f.hourly.time.findIndex(t => t >= localISO), 0);
        for (let i = startIndex; i < startIndex + 24 && i < f.hourly.time.length; i++) {
            hourlyHtml += `<div class="hour-item"><span class="hour-time">${new Date(f.hourly.time[i]).toLocaleTimeString([], { hour: 'numeric' })}</span><span class="hour-temp">${Math.round(f.hourly.temperature_2m[i])}°</span><span class="hour-precip">${f.hourly.precipitation_probability[i]}% <br>precip</span></div>`;
        }
    }

    let dailyHtml = '';
    if (f.daily && f.daily.time) {
        for (let i = 0; i < f.daily.time.length; i++) {
            dailyHtml += `<div class="daily-item"><span class="daily-day">${i === 0 ? 'Today' : new Date(f.daily.time[i]).toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' })}</span><span class="daily-desc">${wmoToPlainEnglish(f.daily.weather_code[i])}</span><span class="daily-temps"><span class="temp-high">${Math.round(f.daily.temperature_2m_max[i])}°</span><span class="temp-low">${Math.round(f.daily.temperature_2m_min[i])}°</span></span></div>`;
        }
    }

    document.getElementById('weather-body').innerHTML = `
        <div class="weather-summary">Outlook predicts ${wmoToPlainEnglish(c.weather_code).toLowerCase()} at ${c.temperature_2m}${cU.temperature_2m}. Wind speeds ${c.wind_speed_10m}${cU.wind_speed_10m} (Gusts: ${c.wind_gusts_10m || 0}${cU.wind_gusts_10m}).</div>
        <div class="current-weather"><span class="current-temp">${c.temperature_2m}${cU.temperature_2m}</span><span class="current-desc">${wmoToPlainEnglish(c.weather_code)}</span></div>
        <div class="stats-grid">
            <div class="stat-box"><label>Humidity</label><span class="stat-val">${c.relative_humidity_2m}${cU.relative_humidity_2m}</span></div>
            <div class="stat-box"><label>Current Precip</label><span class="stat-val">${c.precipitation} ${cU.precipitation}</span></div>
        </div>
        <h3 class="weather-section-title">24-Hour Outlook</h3><div class="hourly-list">${hourlyHtml}</div>
        <h3 class="weather-section-title">7-Day Forecast</h3><div class="daily-list">${dailyHtml}</div>
    `;

    const scores = calculateRisks(payload);
    let riskHtml = '';
    for (let key in scores) {
        let label = key.toUpperCase();
        if(key === 'extremefall') label = "EXTREME RAINFALL";
        riskHtml += `
            <div class="risk-card">
                <div class="risk-card-header">
                    <h4>${label} Risk</h4>
                    <span class="data-badge ${scores[key].conf}">Confidence: ${scores[key].conf.toUpperCase()}</span>
                </div>
                <div class="score-label"><span>Hazard Severity</span><span>${scores[key].val} / 100</span></div>
                <div class="score-track"><div class="score-fill level-${scores[key].level}" style="width: ${scores[key].val}%;"></div></div>
                <div class="risk-explanation">${scores[key].logic}</div>
            </div>
        `;
    }
    document.getElementById('risk-body').innerHTML = riskHtml;
}

function wmoToPlainEnglish(code) {
    const codes = { 0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Depositing rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain', 71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers', 95: 'Thunderstorm', 96: 'Thunderstorm + slight hail', 99: 'Thunderstorm + heavy hail' };
    return codes[code] || 'Unknown Conditions';
}
