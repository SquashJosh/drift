// ---------------------------------------------------------------
// AUTH STATE
// ---------------------------------------------------------------
let currentUser = null;

onAuthChange((user) => {
  currentUser = user;
  updateSaveButtonState();
});

getCurrentUser().then(user => {
  currentUser = user;
  updateSaveButtonState();
  // Restore any waypoints saved before the magic link redirect
  const pending = sessionStorage.getItem('drift_pending_waypoints');
  if (pending) {
    sessionStorage.removeItem('drift_pending_waypoints');
    try {
      const restored = JSON.parse(pending);
      if (restored.length > 0 && user) {
        enterRouteMode();
        const doRestore = async () => {
          reconstructing = true;
          try {
            waypoints.push(...restored);
            initRouteMapLayers();
            drawWaypoints();
            await reconstructLegs(restored, {
              onLeg: (leg) => {
                legs.push(leg);
                drawRoute();
                drawElevationProfile();
                document.getElementById('exportGpxBtn').disabled = false;
                updateSaveButtonState();
              }
            });
          } finally {
            reconstructing = false;
          }
          await doSaveRoute();
        };
        if (map.isStyleLoaded()) {
          doRestore();
        } else {
          map.once('idle', doRestore);
        }
      }
    } catch(e) {
      console.error('Route restore failed:', e);
    }
  }
});

    let clickMode = 'forecast'; // 'forecast' | 'route'
    const ROUTE_COLOUR = '#1a1a1a';     // route line on map
    const PROFILE_COLOUR = '#f0a500';   // elevation profile UI
    let waypoints = [];  // [[lng,lat], ...]
    let legs = [];       // GeoJSON FeatureCollections from BRouter, legs.length === waypoints.length - 1
    let reconstructing = false;
    let routeLayersInitialised = false;

    // Green -> yellow -> orange -> red elevation ramp. Map paint uses these
    // baked to ~0.55 alpha so the basemap shows through; legend uses full
    // opacity for readability against the dark panel.
    const RAMP_RGB = [
      '34, 139, 34',   // forest green (low)
      '154, 205, 50',  // yellow-green
      '255, 215, 0',   // gold
      '255, 140, 0',   // dark orange
      '220, 20, 60',   // crimson (high)
    ];

    const DEM_SOURCE = {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 15,
      attribution: "Elevation: <a href='https://registry.opendata.aws/terrain-tiles/'>AWS Terrain Tiles</a> (Mapzen / 3DEP / others)"
    };

    function currentRampRGB(desaturate) {
      if (!desaturate) return RAMP_RGB;
      return RAMP_RGB.map(rgb => {
        const [r, g, b] = rgb.split(',').map(Number);
        const grey = r * 0.299 + g * 0.587 + b * 0.114;
        const mix = 1.0;
        return [
          Math.round(r + (grey - r) * mix),
          Math.round(g + (grey - g) * mix),
          Math.round(b + (grey - b) * mix)
        ].join(', ');
      });
    }

    function haversine(a, b) {
      const R = 6371;
      const dLat = (b[1] - a[1]) * Math.PI / 180;
      const dLng = (b[0] - a[0]) * Math.PI / 180;
      const s = Math.sin(dLat / 2) ** 2 +
        Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.asin(Math.sqrt(s));
    }

    function buildColorReliefExpr(min, max, desaturate = false) {
      const ramp = currentRampRGB(desaturate);
      let lo = min, hi = max;
      if (hi - lo < 1e-6) hi = lo + 1e-6;
      const n = ramp.length;
      const expr = ['interpolate', ['linear'], ['coalesce', ['elevation'], lo]];
      for (let i = 0; i < n; i++) {
        const val = lo + (hi - lo) * (i / (n - 1));
        expr.push(val, `rgba(${ramp[i]}, 0.55)`);
      }
      return expr;
    }

    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile.bind(protocol));

    const elevationLayerId = 'elevation-tint';
    let beforeLayerId; // first symbol layer in the liberty style

    const DEFAULT_CENTER = [-75.6972, 45.4215];
    let initialCenter = DEFAULT_CENTER;
    let hadCachedCenter = false;
    try {
      const cached = localStorage.getItem('drift_last_center');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length === 2 &&
            typeof parsed[0] === 'number' && typeof parsed[1] === 'number') {
          initialCenter = parsed;
          hadCachedCenter = true;
        }
      }
    } catch (e) {}
    const map = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: initialCenter,
      zoom: 11,
      pitch: 0,
      maxPitch: 0,
      antialias: true,
      attributionControl: false
    });

    class LocateControl {
      onAdd(map) {
        this._map = map;
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        this._container.style.cssText = 'background: rgba(10,12,11,0.62); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.10); border-radius: 4px;';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = 'Go to my location';
        btn.style.cssText = 'width:29px; height:29px; display:flex; align-items:center; justify-content:center; background:transparent; border:none; cursor:pointer; color:rgba(243,241,234,0.55); padding:0;';
        btn.innerHTML = '<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="3"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="9" y1="14" x2="9" y2="17"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="14" y1="9" x2="17" y2="9"/></svg>';

        btn.addEventListener('mouseenter', () => btn.style.color = 'rgba(243,241,234,1)');
        btn.addEventListener('mouseleave', () => btn.style.color = 'rgba(243,241,234,0.55)');
        btn.addEventListener('click', () => {
          if (!navigator.geolocation) return;
          navigator.geolocation.getCurrentPosition(
            (pos) => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 11 }),
            () => {}
          );
        });

        this._container.appendChild(btn);
        return this._container;
      }
      onRemove() {
        this._container.parentNode?.removeChild(this._container);
        this._map = undefined;
      }
    }

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new LocateControl(), 'top-right');
    const attrControl = new maplibregl.AttributionControl({ compact: true });
    map.addControl(attrControl, 'bottom-right');
    // Force closed on load — MapLibre 5.x uses a <details> element;
    // removing 'open' collapses it regardless of viewport width.
    map.once('load', () => {
      const details = document.querySelector('.maplibregl-ctrl-attrib');
      if (details) details.removeAttribute('open');
    });

    function updateColorRelief(min, max) {
      const expr = buildColorReliefExpr(min, max, cyclingVisible);
      try {
        map.setPaintProperty(elevationLayerId, 'color-relief-color', expr);
      } catch (e) {
        if (map.getLayer(elevationLayerId)) map.removeLayer(elevationLayerId);
        map.addLayer({
          id: elevationLayerId,
          type: 'color-relief',
          source: 'terrain-dem',
          paint: { 'color-relief-color': expr }
        }, beforeLayerId);
      }
    }

    function updateLegend(min, max) {
      const N = 6;
      const ticks = [];
      for (let i = 0; i < N; i++) ticks.push(min + (max - min) * (i / (N - 1)));
      document.getElementById('legendTicks').innerHTML = ticks
        .slice().reverse()
        .map(v => `<span>${Math.round(v).toLocaleString()} m</span>`)
        .join('');
    }

    const GRID = 20;
    let lastSampledBounds = null;

    function sampleAndRecolor() {
      const b = map.getBounds();
      const key = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
        .map(v => v.toFixed(4)).join(',');
      if (lastSampledBounds !== null && key === lastSampledBounds) return;

      const sw = b.getSouthWest(), ne = b.getNorthEast();
      const samples = [];
      for (let i = 0; i < GRID; i++) {
        const lng = sw.lng + (ne.lng - sw.lng) * (i / (GRID - 1));
        for (let j = 0; j < GRID; j++) {
          const lat = sw.lat + (ne.lat - sw.lat) * (j / (GRID - 1));
          const el = map.queryTerrainElevation([lng, lat], { exaggerated: false });
          if (el != null) samples.push(el);
        }
      }
      if (samples.length < 40) return; // DEM not ready yet; next idle/moveend retries
      const min = Math.max(0, Math.min(...samples));
      const max = Math.max(...samples);
      updateColorRelief(min, max);
      updateLegend(min, max);
      lastSampledBounds = key;
    }

    let debounceTimer = null;
    function scheduleRecolor() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(sampleAndRecolor, 150);
    }

    let cyclingLoaded = false;
    let cyclingVisible = false;

    function updateLegendBar() {
      const ramp = currentRampRGB(cyclingVisible);
      const stops = ramp.map((rgb, i) => `rgb(${rgb}) ${(i / (ramp.length - 1) * 100).toFixed(1)}%`);
      document.getElementById('legendBar').style.background = `linear-gradient(to top, ${stops.join(', ')})`;
    }
    updateLegendBar();

    map.on('error', (e) => console.error('MapLibre:', e && e.error ? e.error : e));

    map.on('style.load', () => {
      map.addSource('terrain-dem', DEM_SOURCE);
      map.setTerrain({ source: 'terrain-dem', exaggeration: 1 });

      const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
      beforeLayerId = firstSymbol;

      map.addLayer({
        id: elevationLayerId,
        type: 'color-relief',
        source: 'terrain-dem',
        paint: { 'color-relief-color': buildColorReliefExpr(0, 1000) }
      }, beforeLayerId);

      map.once('idle', () => {
        lastSampledBounds = null;
        sampleAndRecolor();
        fetchWindData();
        stackLeftPanels();
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const c = [pos.coords.longitude, pos.coords.latitude];
              try { localStorage.setItem('drift_last_center', JSON.stringify(c)); } catch (e) {}
              if (!hadCachedCenter) map.jumpTo({ center: c, zoom: 11 });
            },
            () => {},
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
          );
        }
      });

      map.on('moveend', scheduleRecolor);
      map.on('idle', scheduleRecolor);

      let raf = null;
      map.on('mousemove', (e) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = null;
          const el = map.queryTerrainElevation(e.lngLat, { exaggerated: false });
          document.getElementById('elev').textContent = (el == null) ? '—' : Math.round(el).toLocaleString() + ' m';
        });
      });
      map.on('mouseout', () => { document.getElementById('elev').textContent = '—'; });
    });

    // ---------------------------------------------------------------
    // LAYERS
    // ---------------------------------------------------------------
    const LAYERS = [
      { id: 'elevation', label: 'Elevation', colour: '#f5c842', visible: true },
      { id: 'wind', label: 'Wind', colour: '#3d8cb5', visible: true },
      { id: 'cycling', label: 'Cycling', colour: '#4caf50', visible: false },
    ];
    const windLayer = LAYERS[1];
    const cyclingLayer = LAYERS[2];

    const CYCLING_LEGEND_ITEMS = [
      { colour: '#4caf50', label: 'Cycle track / bike path' },
      { colour: '#90c840', label: 'Multi-use path' },
      { colour: '#f5c842', label: 'Painted bike lane' },
      { colour: '#a07840', label: 'Gravel trail' },
      { colour: '#888888', label: 'Shared roadway' },
    ];

    const cyclingLegendEl = document.getElementById('cyclingLegend');
    const cyclingLegendItemsEl = document.getElementById('cyclingLegendItems');

    CYCLING_LEGEND_ITEMS.forEach(({ colour, label }) => {
      const item = document.createElement('div');
      item.className = 'cycling-item';
      item.innerHTML = '<div class="cycling-item-line" style="background:' + colour + '"></div>' +
        '<span class="cycling-item-label">' + label + '</span>';
      cyclingLegendItemsEl.appendChild(item);
    });

    function updateCyclingLegend(visible) {
      cyclingLegendEl.style.display = visible ? 'flex' : 'none';
    }

    // ---------------------------------------------------------------
    // WIND: particle system + 7-day forecast scrubber
    // ---------------------------------------------------------------
    const WIND_API = 'https://api.open-meteo.com/v1/forecast';
    const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    let windGrid = null;     // { lats:[3], lngs:[3], points:[9] row-major lat-major/lng-minor }
    let forecastTimes = [];  // 168 ISO time strings
    let selectedHour = 0;
    let selectedDay = 0;
    let lastFetchCenter = null;
    let initialHourSet = false;

    const PARTICLE_COUNT = 300;
    let particles = [];
    let pauseAnimation = false;
    let currentScreenGrid = null; // updated once per frame, used by spawnParticle

    const windCanvas = document.createElement('canvas');
    windCanvas.id = 'wind-canvas';
    document.getElementById('map').appendChild(windCanvas);
    const windCtx = windCanvas.getContext('2d');

    function resizeWindCanvas() {
      const rect = map.getContainer().getBoundingClientRect();
      windCanvas.width = rect.width;
      windCanvas.height = rect.height;
    }
    resizeWindCanvas();
    window.addEventListener('resize', () => { resizeWindCanvas(); respawnAllParticles(); });
    map.on('resize', resizeWindCanvas);

    function bilerp(a, b, c, d, fx, fy) {
      return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    }

    function nearestValidPoint(points, row, col) {
      if (points[row * 3 + col]) return points[row * 3 + col];
      let best = null, bestDist = Infinity;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const p = points[r * 3 + c];
          if (!p) continue;
          const d = Math.abs(r - row) + Math.abs(c - col);
          if (d < bestDist) { bestDist = d; best = p; }
        }
      }
      return best;
    }

    function interpolateWind(lng, lat, hourIdx) {
      if (!windGrid) return null;
      const { lats, lngs, points } = windGrid;
      const clamp01 = (v) => Math.min(1, Math.max(0, v));

      const tx = clamp01((lng - lngs[0]) / (lngs[2] - lngs[0])) * 2;
      const ty = clamp01((lat - lats[0]) / (lats[2] - lats[0])) * 2;
      const ix = Math.min(1, Math.floor(tx));
      const iy = Math.min(1, Math.floor(ty));
      const fx = tx - ix;
      const fy = ty - iy;

      const p00 = nearestValidPoint(points, iy,     ix);
      const p01 = nearestValidPoint(points, iy,     ix + 1);
      const p10 = nearestValidPoint(points, iy + 1, ix);
      const p11 = nearestValidPoint(points, iy + 1, ix + 1);
      if (!p00 || !p01 || !p10 || !p11) return null;

      return {
        U: bilerp(p00.U[hourIdx], p01.U[hourIdx], p10.U[hourIdx], p11.U[hourIdx], fx, fy),
        V: bilerp(p00.V[hourIdx], p01.V[hourIdx], p10.V[hourIdx], p11.V[hourIdx], fx, fy)
      };
    }

    // Inverse-distance weighting across the 9 screen-projected grid points.
    function interpolateScreenWind(x, y, sg) {
      let wU = 0, wV = 0, wSum = 0;
      for (const pt of sg) {
        const dx = x - pt.sx, dy = y - pt.sy;
        const d2 = dx * dx + dy * dy;
        const w = d2 < 1 ? 1e6 : 1 / d2;
        wU += pt.U * w;
        wV += pt.V * w;
        wSum += w;
      }
      return wSum > 0 ? { U: wU / wSum, V: wV / wSum } : null;
    }

    function spawnParticle(p) {
      const sg = currentScreenGrid;
      for (let attempt = 0; attempt < 5; attempt++) {
        const x = Math.random() * windCanvas.width;
        const y = Math.random() * windCanvas.height;
        let speed = 0;
        if (sg) {
          const wind = interpolateScreenWind(x, y, sg);
          speed = wind ? Math.sqrt(wind.U * wind.U + wind.V * wind.V) : 0;
        } else if (windGrid) {
          const lngLat = map.unproject([x, y]);
          const wind = interpolateWind(lngLat.lng, lngLat.lat, selectedHour);
          speed = wind ? Math.sqrt(wind.U * wind.U + wind.V * wind.V) : 0;
        }
        if (speed >= 2 || attempt === 4) {
          p.x = x; p.y = y;
          p.prevX = p.x; p.prevY = p.y;
          p.age = 0;
          p.maxAge = 60 + Math.floor(Math.random() * 40);
          p.speed = speed;
          return;
        }
      }
    }

    function respawnAllParticles() {
      for (const p of particles) spawnParticle(p);
    }

    // Initialise with staggered ages so they don't all fade in at once
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = { x: 0, y: 0, prevX: 0, prevY: 0, age: 0, maxAge: 30, speed: 0 };
      spawnParticle(p);
      p.age = Math.floor(Math.random() * p.maxAge);
      particles.push(p);
    }

    function particleOpacity(age, maxAge) {
      const fadeIn = 10, fadeOut = 8;
      if (age < fadeIn) return 0.85 * (age / fadeIn);
      if (age > maxAge - fadeOut) return 0.85 * Math.max(0, (maxAge - age) / fadeOut);
      return 0.85;
    }

    function animate() {
      requestAnimationFrame(animate);
      if (pauseAnimation || !windGrid || !windLayer.visible) return;

      // 9 map.project() calls per frame instead of 300 map.unproject() calls
      currentScreenGrid = windGrid.points
        .map(pt => {
          if (!pt) return null;
          const px = map.project([pt.lng, pt.lat]);
          return { sx: px.x, sy: px.y, U: pt.U[selectedHour], V: pt.V[selectedHour] };
        })
        .filter(Boolean);

      // Wind particles
      if (windLayer.visible) {
        windCtx.globalCompositeOperation = 'destination-out';
        windCtx.fillStyle = 'rgba(0, 0, 0, 0.05)';
        windCtx.fillRect(0, 0, windCanvas.width, windCanvas.height);
        windCtx.globalCompositeOperation = 'source-over';

        for (const p of particles) {
          const wind = interpolateScreenWind(p.x, p.y, currentScreenGrid);

          p.prevX = p.x;
          p.prevY = p.y;
          if (wind) {
            const spd = Math.sqrt(wind.U * wind.U + wind.V * wind.V);
            if (spd >= 0.001) {
              const speedPx = Math.max(0.3, Math.min(spd * 0.18, 4.0));
              p.x += (wind.U / spd) * speedPx;
              p.y -= (wind.V / spd) * speedPx;
            }
            p.speed = spd || 0;
          }

          const opacity = particleOpacity(p.age, p.maxAge);
          if (opacity > 0) {
            const dx = p.x - p.prevX;
            const dy = p.y - p.prevY;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const tx = dx / len;
            const ty = dy / len;

            windCtx.globalAlpha = opacity;
            windCtx.strokeStyle = '#3d8cb5';
            windCtx.lineWidth = 0.8;
            windCtx.lineCap = 'round';

            // Tail
            windCtx.beginPath();
            windCtx.moveTo(p.prevX, p.prevY);
            windCtx.lineTo(p.x, p.y);
            windCtx.stroke();

            // Arrowhead at leading edge
            const ah = 3.5;
            windCtx.lineWidth = 0.7;
            windCtx.beginPath();
            windCtx.moveTo(p.x - tx * ah + ty * ah * 0.5, p.y - ty * ah - tx * ah * 0.5);
            windCtx.lineTo(p.x, p.y);
            windCtx.lineTo(p.x - tx * ah - ty * ah * 0.5, p.y - ty * ah + tx * ah * 0.5);
            windCtx.stroke();
          }

          p.age++;
          if (p.age >= p.maxAge ||
              p.x < -10 || p.x > windCanvas.width + 10 ||
              p.y < -10 || p.y > windCanvas.height + 10) {
            spawnParticle(p);
          }
        }
        windCtx.globalAlpha = 1;
      }
    }
    requestAnimationFrame(animate);

    map.on('movestart', () => {
      pauseAnimation = true;
      lastSampledBounds = null;
      windCtx.clearRect(0, 0, windCanvas.width, windCanvas.height);
    });
    map.on('moveend', () => {
      pauseAnimation = false;
      respawnAllParticles();
    });

    function positionForecastPanel() {
      if (!pointForecastLocation || pfEl.style.display === 'none') return;
      const isMobile = window.innerWidth <= 600;
      if (isMobile) return;

      const screen = map.project(pointForecastLocation);
      const mapEl = map.getContainer();
      const mw = mapEl.offsetWidth;
      const mh = mapEl.offsetHeight;
      const pw = pfEl.offsetWidth || 320;
      const ph = pfEl.offsetHeight || 260;
      const offset = 16;

      const onRight = screen.x + offset + pw <= mw - 20;
      const x = onRight
        ? screen.x + offset
        : screen.x - offset - pw;

      const above = screen.y - offset - ph >= 60;
      const y = above
        ? screen.y - offset - ph
        : screen.y + offset;

      pfEl.style.left = Math.round(x) + 'px';
      pfEl.style.top = Math.round(y) + 'px';
    }

    map.on('move', () => {
      if (window.innerWidth > 600) positionForecastPanel();
    });

    function nearestHourIndex() {
      if (!forecastTimes.length) return 0;
      const now = Date.now();
      let best = 0, bestDiff = Infinity;
      for (let i = 0; i < forecastTimes.length; i++) {
        const diff = Math.abs(new Date(forecastTimes[i]).getTime() - now);
        if (diff < bestDiff) { bestDiff = diff; best = i; }
      }
      return best;
    }

    function cardinal(deg) {
      return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
    }

    function formatDateTime(iso) {
      const d = new Date(iso);
      const hours = d.getHours();
      const minutes = String(d.getMinutes()).padStart(2, '0');
      const ampm = hours >= 12 ? 'pm' : 'am';
      const h = hours % 12 || 12;
      const timeStr = h + ':' + minutes + ' ' + ampm;
      return WEEKDAYS[d.getDay()] + ' ' + d.getDate() + ' · ' + timeStr;
    }

    const sliderEl = document.getElementById('hourSlider');
    const scrubberTimeEl = document.getElementById('scrubberTime');
    const scrubberWindEl = document.getElementById('scrubberWind');
    const nowBtn = document.getElementById('nowBtn');
    const windLoadingEl = document.getElementById('windLoading');

    function showWindLoading() { windLoadingEl.style.display = 'flex'; }
    function hideWindLoading() { windLoadingEl.style.display = 'none'; }

    function updateSliderPosition() {
      sliderEl.value = selectedHour % 24;
    }

    function renderDayChips() {
      const container = document.getElementById('dayChips');
      container.innerHTML = '';
      for (let i = 0; i < 7; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'day-chip' + (i === selectedDay ? ' active' : '');
        if (forecastTimes.length) {
          const d = new Date(forecastTimes[i * 24]);
          btn.textContent = d.toLocaleDateString(undefined, { weekday: 'short' });
        } else {
          btn.textContent = '···';
        }
        btn.addEventListener('click', () => {
          selectedDay = i;
          if (i === 0) {
            selectedHour = Math.min(167, i * 24 + (selectedHour % 24));
          } else {
            selectedHour = Math.min(167, i * 24 + 8);
          }
          renderDayChips();
          updateSliderPosition();
          updateScrubberReadout();
          respawnAllParticles();
          syncPointForecastToHour();
        });
        container.appendChild(btn);
      }
    }

    function updateScrubberReadout() {
      if (forecastTimes[selectedHour]) scrubberTimeEl.textContent = formatDateTime(forecastTimes[selectedHour]);
      if (windGrid) {
        const centre = windGrid.points[4] || windGrid.points.find(p => p != null);
        if (!centre) return;
        const speed = centre.speed[selectedHour];
        const gust = centre.gust[selectedHour];
        const dir = centre.dir[selectedHour];
        scrubberWindEl.innerHTML = '<b>' + Math.round(speed) + ' km/h</b> ' + cardinal(dir) + ' &nbsp;&middot;&nbsp; gusts <b>' + Math.round(gust) + ' km/h</b>';
      }
      updateSliderPosition();
    }

    sliderEl.addEventListener('input', () => {
      selectedHour = Math.min(167, selectedDay * 24 + parseInt(sliderEl.value, 10));
      updateScrubberReadout();
      respawnAllParticles();
      syncPointForecastToHour();
    });

    nowBtn.addEventListener('click', () => {
      const idx = nearestHourIndex();
      selectedDay = Math.floor(idx / 24);
      selectedHour = idx;
      renderDayChips();
      updateSliderPosition();
      updateScrubberReadout();
      respawnAllParticles();
      syncPointForecastToHour();
    });

    // Initialise placeholder chips on page load
    renderDayChips();

    let windFetchTimer = null;
    let fetchToken = 0;

    function scheduleWindFetch() {
      if (windFetchTimer) clearTimeout(windFetchTimer);
      windFetchTimer = setTimeout(fetchWindData, 400);
    }
    map.on('moveend', scheduleWindFetch);

    async function fetchWindData() {
      const token = ++fetchToken;
      const center = map.getCenter();
      if (lastFetchCenter) {
        const moved = Math.hypot(center.lng - lastFetchCenter.lng, center.lat - lastFetchCenter.lat);
        const bounds = map.getBounds();
        const viewportSpan = bounds.getEast() - bounds.getWest();
        if (moved < viewportSpan * 0.15) return;
      }

      const bounds = map.getBounds();
      const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
      const lats = [0, 1, 2].map((i) => sw.lat + (ne.lat - sw.lat) * (i / 2));
      const lngs = [0, 1, 2].map((i) => sw.lng + (ne.lng - sw.lng) * (i / 2));
      const gridPoints = [];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) gridPoints.push({ lat: lats[i], lng: lngs[j] });

      showWindLoading();
      try {
        const responses = await Promise.all(gridPoints.map((p) => {
          const url = WIND_API + '?latitude=' + p.lat + '&longitude=' + p.lng +
            '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kmh&forecast_days=7&timezone=auto';
          return fetch(url).then((r) => r.ok ? r.json() : null).catch(() => null);
        }));

        if (token !== fetchToken) return; // stale fetch, discard

        const points = gridPoints.map((p, idx) => {
          const data = responses[idx];
          if (!data || !data.hourly) return null;
          const h = data.hourly;
          const n = h.time.length;
          const U = new Float32Array(n), V = new Float32Array(n);
          for (let k = 0; k < n; k++) {
            const rad = (h.wind_direction_10m[k] * Math.PI) / 180;
            U[k] = -h.wind_speed_10m[k] * Math.sin(rad);
            V[k] = -h.wind_speed_10m[k] * Math.cos(rad);
          }
          return { lat: p.lat, lng: p.lng, U, V, speed: h.wind_speed_10m, gust: h.wind_gusts_10m, dir: h.wind_direction_10m };
        });

        const validCount = points.filter(p => p != null).length;
        if (validCount < 4) {
          console.warn('Wind fetch: only ' + validCount + ' valid points, keeping stale data');
          return;
        }

        windGrid = { lats, lngs, points };
        forecastTimes = (responses.find(r => r && r.hourly) || {}).hourly?.time || forecastTimes;
        lastFetchCenter = center;

        if (!initialHourSet) {
          selectedHour = nearestHourIndex();
          selectedDay = Math.floor(selectedHour / 24);
          initialHourSet = true;
        }
        renderDayChips();
        updateSliderPosition();
        updateScrubberReadout();
        respawnAllParticles();
      } catch (err) {
        console.error('Wind fetch failed:', err);
      } finally {
        hideWindLoading();
      }
    }

    // ---------------------------------------------------------------
    // SCRUBBER COLLAPSE
    // ---------------------------------------------------------------
    let scrubberCollapsed = false;
    const scrubberEl = document.getElementById('scrubber');
    const scrubberToggleEl = document.getElementById('scrubberToggle');
    const dayChipsRowEl = document.getElementById('dayChips');
    const sliderRowEl = dayChipsRowEl.nextElementSibling;

    scrubberToggleEl.addEventListener('click', () => {
      scrubberCollapsed = !scrubberCollapsed;
      scrubberToggleEl.textContent = scrubberCollapsed ? '+' : '×';
      dayChipsRowEl.style.display = scrubberCollapsed ? 'none' : '';
      sliderRowEl.style.display = scrubberCollapsed ? 'none' : '';
      scrubberEl.classList.toggle('collapsed', scrubberCollapsed);
    });

    // ---------------------------------------------------------------
    // LAYERS PANEL
    // ---------------------------------------------------------------
    const layersBtnEl = document.getElementById('layersBtn');
    const layersPanelEl = document.getElementById('layersPanel');

    function stackRouteControls() {
      const profileEl = document.getElementById('elevationProfile');
      const controlsEl = document.getElementById('routeControls');
      if (profileEl.style.display !== 'none') {
        controlsEl.style.bottom = (24 + profileEl.offsetHeight + 8) + 'px';
      } else {
        controlsEl.style.bottom = '24px';
      }
    }

    function stackLeftPanels() {
      const STACK_TOP = 56;
      const GAP = 8;
      let currentTop = STACK_TOP;

      if (layersPanelEl.style.display === 'block') {
        currentTop += layersPanelEl.offsetHeight + GAP;
      }

      [document.getElementById('legend'), document.getElementById('cyclingLegend')].forEach(panel => {
        if (!panel) return;
        const isVisible = getComputedStyle(panel).display !== 'none';
        if (isVisible) {
          panel.style.top = currentTop + 'px';
          currentTop += panel.getBoundingClientRect().height + GAP;
        }
      });
    }

    function applyLayerVisibility(layer) {
      if (layer.id === 'wind') {
        windCanvas.style.display = layer.visible ? '' : 'none';
        scrubberEl.style.display = layer.visible ? '' : 'none';
      } else if (layer.id === 'elevation') {
        const vis = layer.visible ? 'visible' : 'none';
        if (map.getLayer('elevation-tint')) map.setLayoutProperty('elevation-tint', 'visibility', vis);
        document.getElementById('legend').style.display = layer.visible ? 'flex' : 'none';
        stackLeftPanels();
      } else if (layer.id === 'cycling') {
        cyclingVisible = layer.visible;
        lastSampledBounds = null;
        scheduleRecolor();
        if (!cyclingLoaded) {
          map.addSource('cycling-pmtiles', {
            type: 'vector',
            url: 'pmtiles:///cycling_canada.pmtiles'
          });
          map.addLayer({
            id: 'cycling-infra-layer',
            type: 'line',
            source: 'cycling-pmtiles',
            'source-layer': 'cycling',
            minzoom: 8,
            layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'visible' },
            paint: {
              'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 3],
              'line-color': ['match', ['get', 'canbics_class'],
                'cycle_track', '#4caf50',
                'bike_path', '#4caf50',
                'local_street_bikeway', '#4caf50',
                'multi_use_path', '#90c840',
                'painted_bike_lane', '#f5c842',
                'gravel_trail', '#a07840',
                '#888888'
              ],
              'line-opacity': 0.85
            }
          }, beforeLayerId);
          cyclingLoaded = true;
        } else {
          map.setLayoutProperty('cycling-infra-layer', 'visibility', layer.visible ? 'visible' : 'none');
        }
        updateCyclingLegend(layer.visible);
        updateLegendBar();
        stackLeftPanels();
      }
    }

    function renderLayersPanel() {
      layersPanelEl.innerHTML = '';
      LAYERS.forEach((layer) => {
        const row = document.createElement('div');
        row.className = 'layer-row';

        const dot = document.createElement('div');
        dot.className = 'layer-dot';
        dot.style.background = layer.colour;

        const label = document.createElement('span');
        label.className = 'layer-label';
        label.textContent = layer.label;

        const switchWrap = document.createElement('label');
        switchWrap.className = 'switch-wrap';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = layer.visible;
        checkbox.addEventListener('change', () => {
          layer.visible = checkbox.checked;
          applyLayerVisibility(layer);
        });

        const track = document.createElement('span');
        track.className = 'switch-track';

        switchWrap.appendChild(checkbox);
        switchWrap.appendChild(track);

        row.appendChild(dot);
        row.appendChild(label);
        row.appendChild(switchWrap);
        layersPanelEl.appendChild(row);
      });

      // How to use
      const divider2 = document.createElement('div');
      divider2.style.cssText = 'border-top: 1px solid var(--hair); margin: 8px 0 6px;';
      layersPanelEl.appendChild(divider2);
      [
        'Click map for point forecast',
        'Hover map for elevation',
      ].forEach(hint => {
        const row = document.createElement('div');
        row.style.cssText = 'font-size:11px;color:var(--ink-dim);padding:2px 0;';
        row.textContent = hint;
        layersPanelEl.appendChild(row);
      });
    }

    const routeBtnEl = document.getElementById('routeBtn');
    const routeControlsEl = document.getElementById('routeControls');

    let priorLayerState = {};

    function enterRouteMode() {
      clickMode = 'route';
      routeBtnEl.classList.add('active');

      // Snapshot current layer visibility
      priorLayerState = {};
      LAYERS.forEach(l => { priorLayerState[l.id] = l.visible; });

      // Set route-mode defaults: elevation off, wind off, cycling on
      LAYERS.forEach(l => {
        let target;
        if (l.id === 'elevation') target = false;
        else if (l.id === 'wind') target = false;
        else if (l.id === 'cycling') target = true;
        else target = l.visible;
        if (l.visible !== target) {
          l.visible = target;
          applyLayerVisibility(l);
        }
      });

      // Close any open forecast panel
      pfEl.style.display = 'none';
      setMobileForecastOpen(false);
      pointForecast = null;
      dayData = null;
      if (currentMarker) { currentMarker.remove(); currentMarker = null; }

      // Swap scrubber for route controls
      scrubberEl.style.display = 'none';
      routeControlsEl.style.display = 'flex';
      stackRouteControls();
      renderLayersPanel();
    }

    function exitRouteMode() {
      clickMode = 'forecast';
      routeBtnEl.classList.remove('active');

      // Restore prior layer visibility
      LAYERS.forEach(l => {
        if (priorLayerState.hasOwnProperty(l.id)) {
          const target = priorLayerState[l.id];
          if (l.visible !== target) {
            l.visible = target;
            applyLayerVisibility(l);
          }
        }
      });

      clearRoute();
      routeControlsEl.style.display = 'none';
      document.getElementById('elevationProfile').style.display = 'none';
      scrubberEl.style.display = '';
      renderLayersPanel();
    }

    routeBtnEl.addEventListener('click', () => {
      if (clickMode === 'route') exitRouteMode();
      else enterRouteMode();
    });

    document.getElementById('undoBtn').addEventListener('click', () => {
      if (waypoints.length === 0) return;
      waypoints.pop();
      if (legs.length > 0) legs.pop();
      drawRoute();
      drawWaypoints();
      drawElevationProfile();
      if (legs.length === 0) {
        document.getElementById('exportGpxBtn').disabled = true;
        updateSaveButtonState();
      }
    });

    document.getElementById('clearRouteBtn').addEventListener('click', clearRoute);
    document.getElementById('exportGpxBtn').addEventListener('click', exportGPX);

    layersBtnEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (layersPanelEl.style.display === 'block') {
        layersPanelEl.style.display = 'none';
        stackLeftPanels();
      } else {
        renderLayersPanel();
        layersPanelEl.style.display = 'block';
        stackLeftPanels();
      }
    });

    document.addEventListener('mousedown', (e) => {
      if (!layersPanelEl.contains(e.target) && !layersBtnEl.contains(e.target)) {
        layersPanelEl.style.display = 'none';
        stackLeftPanels();
      }
    });

    // ---------------------------------------------------------------
    // POINT FORECAST
    // ---------------------------------------------------------------

    let pointForecast = null;
    let pointForecastLocation = null;
    let pointForecastName = null;
    let selectedDayCell = 0;
    let dayData = null;
    let currentMarker = null;
    let profileHoverMarker = null;

    const pfEl = document.getElementById('pointForecast');
    const pfNameEl = document.getElementById('pfName');
    const pfConditionsEl = document.getElementById('pfConditions');
    const pfCloseEl = document.getElementById('pfClose');

    function buildConditionsLine(h, idx) {
      const spd = Math.round(h.wind_speed_10m[idx]);
      const dir = cardinal(h.wind_direction_10m[idx]);
      const gust = Math.round(h.wind_gusts_10m[idx]);
      const temp = Math.round(h.apparent_temperature[idx]);
      const rain = Math.round(h.precipitation_probability[idx] || 0);
      return spd + ' km/h ' + dir + ' · gusts ' + gust + ' km/h · ' + temp + '°C · ' + rain + '% rain';
    }

    function buildDayData(pf) {
      const h = pf.hourly;
      const days = [];
      for (let i = 0; i < 7; i++) {
        let sumU = 0, sumV = 0, sumSpeed = 0;
        let maxGust = 0, minSpeed = Infinity, maxSpeed = 0, maxRainProb = 0;
        for (let k = 0; k < 24; k++) {
          const idx = i * 24 + k;
          const spd = h.wind_speed_10m[idx] || 0;
          const dir = h.wind_direction_10m[idx] || 0;
          const gust = h.wind_gusts_10m[idx] || 0;
          const rain = h.precipitation_probability[idx] || 0;
          const rad = ((dir + 180) % 360) * Math.PI / 180;
          sumU += spd * Math.sin(rad);
          sumV += spd * Math.cos(rad);
          sumSpeed += spd;
          if (gust > maxGust) maxGust = gust;
          if (spd < minSpeed) minSpeed = spd;
          if (spd > maxSpeed) maxSpeed = spd;
          if (rain > maxRainProb) maxRainProb = rain;
        }
        const avgU = sumU / 24, avgV = sumV / 24;
        let dominantDir = Math.atan2(avgU, avgV) * 180 / Math.PI;
        if (dominantDir < 0) dominantDir += 360;
        const d = new Date(h.time[i * 24]);
        days.push({
          avgU, avgV, dominantDir,
          avgSpeed: sumSpeed / 24,
          maxGust, maxRainProb,
          minSpeed: minSpeed === Infinity ? 0 : minSpeed,
          maxSpeed,
          label: WEEKDAYS[d.getDay()],
          date: d
        });
      }
      return days;
    }

    function buildDayCellSVG(day, selected) {
      const R = 20;
      const circ = 2 * Math.PI * R;
      const dash = (day.maxRainProb / 100) * circ;
      const ll = Math.min(18, Math.max(8, 8 + 10 * (day.avgSpeed / 40)));
      const sw = Math.min(3.5, Math.max(1.5, 1.5 + 2 * (day.maxGust / 60)));
      const angle = day.dominantDir * Math.PI / 180;
      const sinA = Math.sin(angle), cosA = Math.cos(angle);
      const x2 = 26 + sinA * ll,         y2 = 26 - cosA * ll;
      const x1 = 26 - sinA * (ll * 0.4), y1 = 26 + cosA * (ll * 0.4);
      const ah = 3;
      const b1x = x2 - sinA * ah + cosA * (ah * 0.7), b1y = y2 + cosA * ah + sinA * (ah * 0.7);
      const b2x = x2 - sinA * ah - cosA * (ah * 0.7), b2y = y2 + cosA * ah - sinA * (ah * 0.7);
      const ring = selected ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.10)';
      const f = v => v.toFixed(2);
      let s = '<svg width="52" height="52" viewBox="0 0 52 52" style="display:block;margin:auto">';
      s += '<circle cx="26" cy="26" r="23" fill="rgba(255,255,255,0.03)" stroke="' + ring + '" stroke-width="1"/>';
      if (day.maxRainProb >= 10) {
        s += '<circle cx="26" cy="26" r="' + R + '" fill="none" stroke="rgba(100,160,255,0.55)" stroke-width="3" ' +
             'stroke-dasharray="' + f(dash) + ' ' + f(circ) + '" stroke-dashoffset="0" ' +
             'stroke-linecap="round" transform="rotate(-90 26 26)"/>';
      }
      s += '<line x1="' + f(x1) + '" y1="' + f(y1) + '" x2="' + f(x2) + '" y2="' + f(y2) + '" ' +
           'stroke="#3d8cb5" stroke-width="' + f(sw) + '" stroke-linecap="round"/>';
      s += '<polygon points="' + f(x2) + ',' + f(y2) + ' ' + f(b1x) + ',' + f(b1y) + ' ' + f(b2x) + ',' + f(b2y) + '" fill="#3d8cb5"/>';
      s += '</svg>';
      return s;
    }

    function renderDayCells() {
      const pfDaysEl = document.getElementById('pfDays');
      if (!pfDaysEl || !dayData) return;
      pfDaysEl.innerHTML = '';
      dayData.forEach((day, i) => {
        const cell = document.createElement('div');
        cell.style.cursor = 'pointer';
        cell.innerHTML = buildDayCellSVG(day, i === selectedDayCell);
        const lbl = document.createElement('div');
        lbl.style.cssText = 'font-size:10px;text-align:center;margin-top:4px;color:' +
          (i === selectedDayCell ? 'var(--ink)' : 'var(--ink-dim)');
        lbl.textContent = day.label;
        cell.appendChild(lbl);
        cell.addEventListener('click', () => {
          selectedDayCell = i;
          renderDayCells();
          renderDetailDiv(dayData[i]);
        });
        pfDaysEl.appendChild(cell);
      });
    }

    function renderDetailDiv(day) {
      const pfDetailEl = document.getElementById('pfDetail');
      if (!pfDetailEl) return;
      const weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const fullDate = weekdays[day.date.getDay()] + ', ' + MONTHS[day.date.getMonth()] + ' ' + day.date.getDate();
      const windLine = Math.round(day.minSpeed) + '–' + Math.round(day.maxSpeed) + ' km/h · ' +
                       'gusts ' + Math.round(day.maxGust) + ' km/h · ' + cardinal((day.dominantDir + 180) % 360);
      const rainLine = day.maxRainProb >= 10
        ? '<div style="font-size:11px;color:rgba(100,160,255,0.9)">🌧 ' + Math.round(day.maxRainProb) + '% chance of rain</div>'
        : '<div style="font-size:11px;color:var(--ink-dim)">No significant rain</div>';
      pfDetailEl.innerHTML =
        '<div style="font-size:12px;color:var(--ink);font-weight:500;margin-bottom:2px">' + fullDate + '</div>' +
        '<div style="font-size:12px;color:var(--ink-dim);margin-bottom:3px">' + windLine + '</div>' +
        rainLine;
    }

    function setMobileForecastOpen(open) {
      if (window.innerWidth > 600) return;
      if (open) {
        scrubberCollapsed = true;
        scrubberToggleEl.textContent = '+';
        dayChipsRowEl.style.display = 'none';
        sliderRowEl.style.display = 'none';
        scrubberEl.classList.add('collapsed');
        pfEl.style.position = 'fixed';
        pfEl.style.left = '0';
        pfEl.style.right = '0';
        pfEl.style.bottom = scrubberEl.offsetHeight + 'px';
        pfEl.style.top = 'auto';
        pfEl.style.width = '100%';
        pfEl.style.borderRadius = '8px 8px 0 0';
        pfEl.style.transform = 'none';
      } else {
        scrubberCollapsed = false;
        scrubberToggleEl.textContent = '×';
        dayChipsRowEl.style.display = '';
        sliderRowEl.style.display = '';
        scrubberEl.classList.remove('collapsed');
      }
    }

    function renderPointForecastPanel() {
      if (!pointForecast) return;
      pfNameEl.textContent = pointForecastName;
      pfConditionsEl.textContent = buildConditionsLine(pointForecast.hourly, selectedHour);
      dayData = buildDayData(pointForecast);
      selectedDayCell = Math.floor(selectedHour / 24);
      renderDayCells();
      renderDetailDiv(dayData[selectedDayCell]);
      setMobileForecastOpen(true);
      pfEl.style.display = 'flex';
      positionForecastPanel();
    }

    function syncPointForecastToHour() {
      if (!pointForecast || pfEl.style.display === 'none') return;
      pfConditionsEl.textContent = buildConditionsLine(pointForecast.hourly, selectedHour);
    }

    pfCloseEl.addEventListener('click', () => {
      pfEl.style.display = 'none';
      setMobileForecastOpen(false);
      pointForecast = null;
      dayData = null;
      if (currentMarker) { currentMarker.remove(); currentMarker = null; }
    });

    function initRouteMapLayers() {
      if (routeLayersInitialised) return;
      map.addSource('route-data', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('waypoints-data', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route-data',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ROUTE_COLOUR, 'line-width': 3, 'line-opacity': 0.9 }
      }, beforeLayerId);

      map.addLayer({
        id: 'route-waypoints',
        type: 'circle',
        source: 'waypoints-data',
        paint: {
          'circle-radius': 5,
          'circle-color': '#0a0d0c',
          'circle-stroke-color': ROUTE_COLOUR,
          'circle-stroke-width': 2
        }
      }, beforeLayerId);

      routeLayersInitialised = true;
    }

    function drawRoute() {
      if (!routeLayersInitialised) return;
      const coords = legs.flatMap(leg => {
        const f = leg.features[0];
        return f ? f.geometry.coordinates : [];
      });
      map.getSource('route-data').setData({
        type: 'FeatureCollection',
        features: coords.length ? [{
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords }
        }] : []
      });
    }

    function drawWaypoints() {
      if (!routeLayersInitialised) return;
      map.getSource('waypoints-data').setData({
        type: 'FeatureCollection',
        features: waypoints.map((wp, i) => ({
          type: 'Feature',
          properties: { index: i },
          geometry: { type: 'Point', coordinates: wp }
        }))
      });
    }

    function renderElevationProfile(svgEl, statsEl, legsData, onHover) {
      if (!legsData || legsData.length === 0) return;

      const allCoords = [];
      let cumDist = 0;
      let prevCoord = null;
      let totalGain = 0;
      let prevEle = null;

      for (const leg of legsData) {
        const f = leg.features[0];
        if (!f) continue;
        for (const coord of f.geometry.coordinates) {
          const ele = coord[2] ?? 0;
          if (prevCoord) cumDist += haversine(prevCoord, coord);
          if (prevEle !== null && ele > prevEle) totalGain += ele - prevEle;
          allCoords.push({ coord, dist: cumDist });
          prevCoord = coord;
          prevEle = ele;
        }
      }

      if (allCoords.length < 2) return;

      const totalDist = cumDist;
      const eles = allCoords.map(p => p.coord[2] ?? 0);
      const minEle = Math.min(...eles);
      const maxEle = Math.max(...eles);
      const eleRange = maxEle - minEle || 1;

      const W = 800, H = 120, pad = 2;
      const toX = d => pad + (d / totalDist) * (W - pad * 2);
      const toY = e => H - pad - ((e - minEle) / eleRange) * (H - pad * 2);

      const pathD = allCoords.map((p, i) =>
        (i === 0 ? 'M' : 'L') + toX(p.dist).toFixed(1) + ',' + toY(p.coord[2] ?? 0).toFixed(1)
      ).join(' ');

      const areaD = pathD +
        ' L' + toX(totalDist).toFixed(1) + ',' + H +
        ' L' + toX(0).toFixed(1) + ',' + H + ' Z';

      // Distance markers
      const markerCount = 6;
      let markers = '';
      for (let i = 1; i < markerCount; i++) {
        const d = totalDist * (i / markerCount);
        const x = toX(d).toFixed(1);
        markers += '<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + H + '" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>';
        markers += '<text x="' + x + '" y="' + (H - 4) + '" fill="rgba(243,241,234,0.3)" font-size="10" text-anchor="middle" font-family="system-ui">' + d.toFixed(0) + ' km</text>';
      }

      svgEl.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svgEl.innerHTML =
        '<defs>' +
          '<linearGradient id="profGrad' + svgEl.id + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="' + PROFILE_COLOUR + '" stop-opacity="0.4"/>' +
            '<stop offset="100%" stop-color="' + PROFILE_COLOUR + '" stop-opacity="0.05"/>' +
          '</linearGradient>' +
        '</defs>' +
        markers +
        '<path d="' + areaD + '" fill="url(#profGrad' + svgEl.id + ')"/>' +
        '<path d="' + pathD + '" fill="none" stroke="' + PROFILE_COLOUR + '" stroke-width="1.5" stroke-linejoin="round"/>' +
        '<line id="profCursor_' + svgEl.id + '" x1="0" y1="0" x2="0" y2="' + H + '" stroke="rgba(255,255,255,0.4)" stroke-width="1" display="none"/>';

      statsEl.innerHTML =
        '<b>' + totalDist.toFixed(1) + ' km</b>' +
        ' &nbsp;·&nbsp; ' +
        '<b>↑ ' + Math.round(totalGain) + ' m</b>';

      // Hover
      svgEl.onmousemove = (e) => {
        const rect = svgEl.getBoundingClientRect();
        const cssX = e.clientX - rect.left;
        const frac = Math.max(0, Math.min(1, cssX / rect.width));
        const hoverDist = frac * totalDist;

        let nearest = allCoords[0];
        let bestDiff = Infinity;
        for (const pt of allCoords) {
          const diff = Math.abs(pt.dist - hoverDist);
          if (diff < bestDiff) { bestDiff = diff; nearest = pt; }
        }

        const cursorEl = document.getElementById('profCursor_' + svgEl.id);
        if (cursorEl) {
          const cx = toX(nearest.dist).toFixed(1);
          cursorEl.setAttribute('x1', cx);
          cursorEl.setAttribute('x2', cx);
          cursorEl.setAttribute('display', '');
        }

        if (onHover) onHover(nearest.coord);
      };

      svgEl.onmouseleave = () => {
        const cursorEl = document.getElementById('profCursor_' + svgEl.id);
        if (cursorEl) cursorEl.setAttribute('display', 'none');
        if (onHover) onHover(null);
      };

      return { allCoords, totalDist, totalGain, minEle, maxEle };
    }

    function drawElevationProfile() {
      const profileEl = document.getElementById('elevationProfile');
      const svgEl = document.getElementById('profileSvg');
      const statsEl = document.getElementById('profileStats');

      if (legs.length === 0) {
        profileEl.style.display = 'none';
        stackRouteControls();
        return;
      }

      renderElevationProfile(svgEl, statsEl, legs, (coord) => {
        if (!coord) {
          if (profileHoverMarker) { profileHoverMarker.remove(); profileHoverMarker = null; }
          return;
        }
        const lngLat = [coord[0], coord[1]];
        if (!profileHoverMarker) {
          const el = document.createElement('div');
          el.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid #1a1a1a;pointer-events:none;';
          profileHoverMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
        } else {
          profileHoverMarker.setLngLat(lngLat);
        }
      });

      profileEl.style.display = 'flex';
      stackRouteControls();
    }

    async function fetchLeg(from, to) {
      const url = 'https://brouter.de/brouter' +
        '?lonlats=' + from[0] + ',' + from[1] + '|' + to[0] + ',' + to[1] +
        '&profile=trekking&alternativeidx=0&format=geojson';
      const res = await fetch(url);
      if (!res.ok) throw new Error('BRouter HTTP ' + res.status);
      const data = await res.json();
      if (!data.features || !data.features.length) throw new Error('BRouter: no route found');
      return data;
    }

    function exportGPX() {
      const coords = legs.flatMap(leg => {
        const f = leg.features[0];
        return f ? f.geometry.coordinates : [];
      });
      if (!coords.length) return;
      const trkpts = coords.map(c =>
        '    <trkpt lat="' + c[1] + '" lon="' + c[0] + '">' +
        (c[2] != null ? '<ele>' + c[2].toFixed(1) + '</ele>' : '') +
        '</trkpt>'
      ).join('\n');
      const gpx = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<gpx version="1.1" creator="Drift" xmlns="http://www.topografix.com/GPX/1/1">\n' +
        '  <trk><trkseg>\n' + trkpts + '\n  </trkseg></trk>\n</gpx>';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
      a.download = 'drift-route.gpx';
      a.click();
    }

    /**
     * Fetch BRouter legs for an ordered array of waypoints.
     * Calls onLeg(leg, index) after each successful fetch.
     * Returns the array of all legs fetched.
     */
    async function reconstructLegs(waypointList, { onLeg } = {}) {
      const result = [];
      for (let i = 1; i < waypointList.length; i++) {
        try {
          const leg = await fetchLeg(waypointList[i - 1], waypointList[i]);
          result.push(leg);
          if (onLeg) onLeg(leg, i - 1);
        } catch (err) {
          console.error('Leg reconstruction failed:', err, 'from:', waypointList[i-1], 'to:', waypointList[i]);
        }
      }
      return result;
    }

    function clearRoute() {
      waypoints = [];
      legs = [];
      if (routeLayersInitialised) {
        drawRoute();
        drawWaypoints();
      }
      if (profileHoverMarker) { profileHoverMarker.remove(); profileHoverMarker = null; }
      document.getElementById('elevationProfile').style.display = 'none';
      document.getElementById('exportGpxBtn').disabled = true;
      stackRouteControls();
      activeRouteId = null;
      updateSaveButtonState();
    }

    async function handleRouteClick(e) {
      if (reconstructing) return;
      const { lng, lat } = e.lngLat;
      waypoints.push([lng, lat]);
      initRouteMapLayers();
      drawWaypoints();

      if (waypoints.length < 2) return;

      const from = waypoints[waypoints.length - 2];
      const to = waypoints[waypoints.length - 1];

      try {
        const leg = await fetchLeg(from, to);
        legs.push(leg);
        drawRoute();
        drawElevationProfile();
        document.getElementById('exportGpxBtn').disabled = false;
        updateSaveButtonState();
      } catch (err) {
        console.error('Route leg failed:', err);
        // Roll back the waypoint we just added
        waypoints.pop();
        drawWaypoints();
      }
    }

    async function handleForecastClick(e) {
      const { lng, lat } = e.lngLat;
      const features = map.queryRenderedFeatures(e.point);
      const named = features.find(f => f.properties && typeof f.properties.name === 'string' && f.properties.name.trim());
      pointForecastName = named
        ? named.properties.name
        : Math.abs(lat).toFixed(2) + '°' + (lat >= 0 ? 'N' : 'S') + ' · ' + Math.abs(lng).toFixed(2) + '°' + (lng >= 0 ? 'E' : 'W');
      pointForecastLocation = e.lngLat;

      const el = document.createElement('div');
      el.className = 'drift-pin';
      if (currentMarker) currentMarker.remove();
      currentMarker = new maplibregl.Marker({ element: el })
        .setLngLat(e.lngLat)
        .addTo(map);

      pfNameEl.textContent = pointForecastName;
      pfConditionsEl.textContent = 'Fetching forecast…';
      pfEl.style.display = 'flex';

      try {
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lng +
          '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability,precipitation,apparent_temperature' +
          '&wind_speed_unit=kmh&forecast_days=7&timezone=auto';
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        pointForecast = await res.json();
        renderPointForecastPanel();
      } catch (err) {
        console.error('Point forecast fetch failed:', err);
        pfConditionsEl.textContent = 'Failed to load forecast.';
      }
    }

    map.on('click', (e) => {
      if (clickMode === 'forecast') handleForecastClick(e);
      else if (clickMode === 'route') handleRouteClick(e);
    });

// ---------------------------------------------------------------
// AUTH MODAL
// ---------------------------------------------------------------
const authModalEl = document.getElementById('authModal');
const authEmailEl = document.getElementById('authEmail');
const authSendBtn = document.getElementById('authSendBtn');
const authMessageEl = document.getElementById('authMessage');
const authCloseBtn = document.getElementById('authCloseBtn');

function openAuthModal() {
  authEmailEl.value = '';
  authMessageEl.textContent = '';
  authMessageEl.className = '';
  authSendBtn.disabled = false;
  authSendBtn.textContent = 'Send link';
  authModalEl.classList.add('open');
  setTimeout(() => authEmailEl.focus(), 50);
}

function closeAuthModal() {
  authModalEl.classList.remove('open');
}

authCloseBtn.addEventListener('click', closeAuthModal);

authModalEl.addEventListener('click', (e) => {
  if (e.target === authModalEl) closeAuthModal();
});

// Before Supabase redirects away, snapshot waypoints to sessionStorage
function snapshotRouteForRedirect() {
  if (waypoints.length > 0) {
    sessionStorage.setItem('drift_pending_waypoints', JSON.stringify(waypoints));
  }
}

authSendBtn.addEventListener('click', async () => {
  const email = authEmailEl.value.trim();
  if (!email) {
    authMessageEl.textContent = 'Please enter your email address.';
    authMessageEl.className = 'error';
    return;
  }
  authSendBtn.disabled = true;
  authSendBtn.textContent = 'Sending…';
  authMessageEl.textContent = '';
  authMessageEl.className = '';
  try {
    snapshotRouteForRedirect();
    await signIn(email);
    authMessageEl.textContent = 'Check your email — we sent you a sign-in link.';
    authMessageEl.className = 'success';
    authSendBtn.textContent = 'Sent';
  } catch (err) {
    console.error('Sign in error:', err);
    authMessageEl.textContent = 'Something went wrong. Please try again.';
    authMessageEl.className = 'error';
    authSendBtn.disabled = false;
    authSendBtn.textContent = 'Send link';
  }
});

// ---------------------------------------------------------------
// SAVE ROUTE
// ---------------------------------------------------------------
const saveRouteBtnEl = document.getElementById('saveRouteBtn');
let activeRouteId = null; // id of the route currently loaded from My Routes, null if fresh
let viewingRouteId = null; // non-null when a route is loaded in view mode

function updateSaveButtonState() {
  if (!saveRouteBtnEl) return;
  saveRouteBtnEl.disabled = legs.length === 0;
}

function generateRouteName() {
  const now = new Date();
  const month = now.toLocaleDateString(undefined, { month: 'short' });
  const day = now.getDate();
  const dist = legs.length > 0 ? (() => {
    let d = 0, prev = null;
    for (const leg of legs) {
      const f = leg.features[0];
      if (!f) continue;
      for (const c of f.geometry.coordinates) {
        if (prev) d += haversine(prev, c);
        prev = c;
      }
    }
    return d.toFixed(1);
  })() : '0';
  return 'Route — ' + month + ' ' + day + ', ' + dist + ' km';
}

async function doSaveRoute() {
  const dist = (() => {
    let d = 0, prev = null;
    for (const leg of legs) {
      const f = leg.features[0];
      if (!f) continue;
      for (const c of f.geometry.coordinates) {
        if (prev) d += haversine(prev, c);
        prev = c;
      }
    }
    return parseFloat(d.toFixed(2));
  })();

  const gain = (() => {
    let g = 0, prevEle = null;
    for (const leg of legs) {
      const f = leg.features[0];
      if (!f) continue;
      for (const c of f.geometry.coordinates) {
        const ele = c[2] ?? 0;
        if (prevEle !== null && ele > prevEle) g += ele - prevEle;
        prevEle = ele;
      }
    }
    return Math.round(g);
  })();

  const geometry = legs.flatMap(leg => {
    const f = leg.features[0];
    return f ? f.geometry.coordinates : [];
  });

  const routeObject = {
    name: generateRouteName(),
    waypoints,
    distance_km: dist,
    gain_m: gain,
    geometry,
  };

  saveRouteBtnEl.disabled = true;
  saveRouteBtnEl.textContent = 'Saving…';

  try {
    if (activeRouteId) {
      // Existing route — offer save over or save as new
      const choice = confirm('Save over existing route, or save as a new route?\n\nOK = Save over\nCancel = Save as new');
      if (choice) {
        await updateRoute(activeRouteId, {
          waypoints: routeObject.waypoints,
          distance_km: routeObject.distance_km,
          gain_m: routeObject.gain_m,
          geometry: routeObject.geometry,
        });
      } else {
        const saved = await saveRoute(routeObject);
        activeRouteId = saved.id;
      }
    } else {
      const saved = await saveRoute(routeObject);
      activeRouteId = saved.id;
    }
    saveRouteBtnEl.textContent = 'Saved ✓';
    setTimeout(() => {
      saveRouteBtnEl.textContent = 'Save';
      saveRouteBtnEl.disabled = legs.length === 0;
    }, 2000);
  } catch (err) {
    console.error('Save failed:', err);
    saveRouteBtnEl.textContent = 'Save';
    saveRouteBtnEl.disabled = false;
  }
}

saveRouteBtnEl.addEventListener('click', async () => {
  if (!currentUser) {
    openAuthModal();
    return;
  }
  await doSaveRoute();
});

// ---------------------------------------------------------------
// MY ROUTES VIEW
// ---------------------------------------------------------------
const myRoutesViewEl = document.getElementById('myRoutesView');
const myRoutesBtnEl = document.getElementById('myRoutesBtn');
const myRoutesBackEl = document.getElementById('myRoutesBack');
const myRoutesSignOutEl = document.getElementById('myRoutesSignOut');
const myRoutesLoadingEl = document.getElementById('myRoutesLoading');
const myRoutesEmptyEl = document.getElementById('myRoutesEmpty');
const myRoutesSignedOutEl = document.getElementById('myRoutesSignedOut');
const myRoutesGridEl = document.getElementById('myRoutesGrid');
const myRoutesAuthMsgEl = document.getElementById('myRoutesAuthMsg');
const myRoutesSendBtnEl = document.getElementById('myRoutesSendBtn');
const myRoutesEmailEl = document.getElementById('myRoutesEmail');
const editRouteBtnEl = document.getElementById('editRouteBtn');

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function openMyRoutes() {
  myRoutesViewEl.classList.add('open');
  loadMyRoutes();
}

function closeMyRoutes() {
  myRoutesViewEl.classList.remove('open');
}

async function loadMyRoutes() {
  myRoutesLoadingEl.style.display = 'block';
  myRoutesEmptyEl.style.display = 'none';
  myRoutesSignedOutEl.style.display = 'none';
  myRoutesGridEl.innerHTML = '';

  if (!currentUser) {
    myRoutesLoadingEl.style.display = 'none';
    myRoutesSignedOutEl.style.display = 'flex';
    myRoutesSignOutEl.style.display = 'none';
    return;
  }

  myRoutesSignOutEl.style.display = '';

  try {
    const routes = await listRoutes();
    myRoutesLoadingEl.style.display = 'none';

    if (!routes || routes.length === 0) {
      myRoutesEmptyEl.style.display = 'flex';
      return;
    }

    routes.forEach(route => {
      const card = document.createElement('div');
      card.className = 'route-card';

      const thumbnailDiv = document.createElement('div');
      thumbnailDiv.className = 'route-card-thumbnail';
      card.appendChild(thumbnailDiv);

      const cardBody = document.createElement('div');
      cardBody.className = 'route-card-body';

      const name = document.createElement('div');
      name.className = 'route-card-name';
      name.textContent = route.name;
      name.contentEditable = true;
      name.spellcheck = false;
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
      });
      name.addEventListener('blur', async () => {
        const newName = name.textContent.trim();
        if (newName && newName !== route.name) {
          try {
            await renameRoute(route.id, newName);
            route.name = newName;
          } catch (err) {
            console.error('Rename failed:', err);
            name.textContent = route.name;
          }
        }
      });
      name.addEventListener('click', (e) => e.stopPropagation());

      const stats = document.createElement('div');
      stats.className = 'route-card-stats';
      stats.innerHTML =
        '<span>' + (route.distance_km || 0) + ' km</span>' +
        '<span>↑ ' + (route.gain_m || 0) + ' m</span>';

      const date = document.createElement('div');
      date.className = 'route-card-date';
      date.textContent = formatDate(route.created_at);

      const actions = document.createElement('div');
      actions.className = 'route-card-actions';

      const loadBtn = document.createElement('button');
      loadBtn.className = 'route-card-load';
      loadBtn.textContent = 'Open on map';
      loadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        enterViewMode(route);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'route-card-delete';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete "' + route.name + '"?')) return;
        try {
          await deleteRoute(route.id);
          card.remove();
          if (myRoutesGridEl.children.length === 0) {
            myRoutesEmptyEl.style.display = 'flex';
          }
        } catch (err) {
          console.error('Delete failed:', err);
        }
      });

      actions.appendChild(loadBtn);
      actions.appendChild(deleteBtn);
      cardBody.appendChild(name);
      cardBody.appendChild(stats);
      cardBody.appendChild(date);
      cardBody.appendChild(actions);
      card.appendChild(cardBody);
      myRoutesGridEl.appendChild(card);

      const thumbMap = new maplibregl.Map({
        container: thumbnailDiv,
        style: 'https://tiles.openfreemap.org/styles/liberty',
        interactive: false,
        attributionControl: false,
      });

      thumbMap.once('load', () => {
        const coords = route.geometry
          ? route.geometry
          : (typeof route.waypoints === 'string'
              ? JSON.parse(route.waypoints)
              : route.waypoints);

        if (!coords || coords.length < 2) return;

        thumbMap.addSource('thumb-route', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: coords }
            }]
          }
        });
        thumbMap.addLayer({
          id: 'thumb-route-line',
          type: 'line',
          source: 'thumb-route',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#f0a500', 'line-width': 2.5, 'line-opacity': 0.95 }
        });

        const lngs = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        thumbMap.fitBounds([
          [Math.min(...lngs) - 0.005, Math.min(...lats) - 0.005],
          [Math.max(...lngs) + 0.005, Math.max(...lats) + 0.005]
        ], { padding: 24, animate: false });
      });
    });

  } catch (err) {
    console.error('Failed to load routes:', err);
    myRoutesLoadingEl.style.display = 'none';
    myRoutesLoadingEl.textContent = 'Failed to load routes.';
    myRoutesLoadingEl.style.display = 'block';
  }
}

async function loadRouteOntoMap(route) {
  closeMyRoutes();
  clearRoute();
  enterRouteMode();
  activeRouteId = route.id;

  const restored = typeof route.waypoints === 'string'
    ? JSON.parse(route.waypoints)
    : route.waypoints;
  console.log('waypoints from Supabase:', restored);
  if (!restored || restored.length < 2) return;

  (async () => {
    for (const wp of restored) waypoints.push(wp);
    initRouteMapLayers();
    drawWaypoints();
    reconstructing = true;
    try {
      await reconstructLegs(restored, {
        onLeg: (leg) => {
          legs.push(leg);
          drawRoute();
          drawElevationProfile();
          document.getElementById('exportGpxBtn').disabled = false;
          updateSaveButtonState();
        }
      });
    } finally {
      reconstructing = false;
    }
  })();
}

function enterViewMode(route) {
  const coords = route.geometry && route.geometry.length >= 2
    ? route.geometry
    : null;

  if (!coords) {
    viewingRouteId = null;
    loadRouteOntoMap(route);
    return;
  }

  clickMode = 'forecast';
  viewingRouteId = route.id;
  activeRouteId = route.id;
  closeMyRoutes();

  legs = [];
  waypoints = typeof route.waypoints === 'string'
    ? JSON.parse(route.waypoints)
    : (route.waypoints || []);

  initRouteMapLayers();
  map.getSource('route-data').setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords }
    }]
  });
  drawWaypoints();
  editRouteBtnEl.style.display = '';
}

function exitViewMode() {
  viewingRouteId = null;
  activeRouteId = null;
  clearRoute();
  editRouteBtnEl.style.display = 'none';
}

editRouteBtnEl.addEventListener('click', () => {
  viewingRouteId = null;
  editRouteBtnEl.style.display = 'none';
  enterRouteMode();
});

myRoutesSendBtnEl.addEventListener('click', async () => {
  const email = myRoutesEmailEl.value.trim();
  if (!email) {
    myRoutesAuthMsgEl.textContent = 'Please enter your email.';
    return;
  }
  myRoutesSendBtnEl.disabled = true;
  myRoutesSendBtnEl.textContent = 'Sending…';
  try {
    await signIn(email);
    myRoutesAuthMsgEl.textContent = 'Check your email for a sign-in link.';
    myRoutesAuthMsgEl.style.color = '#6ec97a';
    myRoutesSendBtnEl.textContent = 'Sent';
  } catch (err) {
    myRoutesAuthMsgEl.textContent = 'Something went wrong. Try again.';
    myRoutesSendBtnEl.disabled = false;
    myRoutesSendBtnEl.textContent = 'Send sign-in link';
  }
});

myRoutesBtnEl.addEventListener('click', openMyRoutes);
myRoutesBackEl.addEventListener('click', closeMyRoutes);

myRoutesSignOutEl.addEventListener('click', async () => {
  await signOut();
  currentUser = null;
  updateSaveButtonState();
  loadMyRoutes();
});


