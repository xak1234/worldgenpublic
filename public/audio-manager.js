var AudioManager = (function() {
  var STORAGE_PREFIX = 'worldgen:audio';
  var FADE_DURATION = 1000;
  var FADE_STEPS = 20;
  var THROTTLE_MS = 90;
  var MAX_CONCURRENT = 2;
  var MAX_PLAY_MS = 1200;

  function loadFloat(key, fallback) {
    try { var v = localStorage.getItem(STORAGE_PREFIX + key); return v !== null ? parseFloat(v) : fallback; }
    catch(e) { return fallback; }
  }
  function saveFloat(key, v) {
    try { localStorage.setItem(STORAGE_PREFIX + key, String(v)); } catch(e) {}
  }
  function loadBool(key) {
    try { return localStorage.getItem(STORAGE_PREFIX + key) === '1'; } catch(e) { return false; }
  }
  function saveBool(key, v) {
    try { localStorage.setItem(STORAGE_PREFIX + key, v ? '1' : '0'); } catch(e) {}
  }

  var _masterVol = loadFloat('MasterVol', 0.7);
  var _catVol = {
    ui:      loadFloat('Vol_ui', 1.0),
    sfx:     loadFloat('Vol_sfx', 1.0),
    music:   loadFloat('Vol_music', 0.5),
    ambient: loadFloat('Vol_ambient', 0.7)
  };
  var _muted = loadBool('Muted');
  if (!isFinite(_masterVol) || _masterVol < 0) _masterVol = 0.7;
  if (!isFinite(_catVol.ui) || _catVol.ui < 0) _catVol.ui = 1.0;
  if (!isFinite(_catVol.sfx) || _catVol.sfx < 0) _catVol.sfx = 1.0;
  if (!isFinite(_catVol.music) || _catVol.music < 0) _catVol.music = 0.5;
  if (!isFinite(_catVol.ambient) || _catVol.ambient < 0) _catVol.ambient = 0.7;
  saveBool('Muted', _muted);
  saveFloat('MasterVol', _masterVol);
  saveFloat('Vol_ui', _catVol.ui);
  saveFloat('Vol_sfx', _catVol.sfx);
  saveFloat('Vol_music', _catVol.music);
  saveFloat('Vol_ambient', _catVol.ambient);
  var _userInteracted = false;
  var _throttleMap = {};
  var _activeOneShots = {};
  var _liveOneShots = [];
  var _oneShotTemplates = {};
  var _pendingOneShots = [];

  var _currentMusic = null;
  var _currentMusicId = null;
  var _currentAmbient = null;
  var _currentAmbientId = null;
  var _currentWeatherAmbient = null;
  var _currentWeatherAmbientId = null;
  var _pendingMusic = null;
  var _pendingAmbient = null;
  var _pendingWeatherAmbient = null;
  var _soundscapeLayers = [];
  var _soundscapeFadeTimers = [];
  var _soundscapeContextHash = null;
  var _pendingSoundscape = null;
  var _soundscapeFallbackAmbient = null;
  var _soundscapeFallbackWeather = null;
  var SOUNDSCAPE_FADE_MS = 2000;
  var SOUNDSCAPE_FADE_STEPS = 40;
  var _settingsOpen = false;

  function onInteract() {
    if (_userInteracted) return;
    _userInteracted = true;
    if (_pendingMusic) { mgr.playMusic(_pendingMusic); _pendingMusic = null; }
    if (_pendingAmbient) { mgr.setAmbient(_pendingAmbient); _pendingAmbient = null; }
    if (_pendingWeatherAmbient) { mgr.setWeatherAmbient(_pendingWeatherAmbient); _pendingWeatherAmbient = null; }
    if (_pendingSoundscape) { mgr.setSoundscape(_pendingSoundscape); _pendingSoundscape = null; }
    if (_pendingOneShots.length) {
      var pending = _pendingOneShots.splice(0);
      pending.forEach(function(soundId) { mgr.play(soundId); });
    }
  }
  document.addEventListener('click', onInteract, { once: true });

  (function injectConversationButtonStyle() {
    if (document.getElementById('wg-conv-action-contrast-style')) return;
    var style = document.createElement('style');
    style.id = 'wg-conv-action-contrast-style';
    style.textContent = [
      '.conv-actions .action-btn{color:#f8fafc!important;border-color:rgba(125,211,252,.36)!important;background:rgba(56,189,248,.10)!important;text-shadow:0 0 8px rgba(125,211,252,.36)!important}',
      '.conv-actions .action-btn:hover{color:#fff!important;border-color:rgba(125,211,252,.72)!important;background:rgba(56,189,248,.18)!important;text-shadow:0 0 10px rgba(125,211,252,.58)!important}',
      '.conv-messages .msg.actionmsg{font-size:12px!important;line-height:1.35!important;padding:6px 10px!important;max-width:82%;opacity:.92}',
      'button[aria-label="Study exits"],button[aria-label="Wait 1 hour"]{display:none!important}'
    ].join('\n');
    document.head.appendChild(style);
  })();
  document.addEventListener('pointerdown', onInteract, { once: true });
  document.addEventListener('keydown', onInteract, { once: true });

  function effectiveVolume(config) {
    if (_muted) return 0;
    var cat = _catVol[config.category] !== undefined ? _catVol[config.category] : 1;
    return (config.volume || 1) * cat * _masterVol;
  }

  function fadeIn(audio, targetVol, cb) {
    var step = targetVol / FADE_STEPS;
    var current = 0;
    audio.volume = 0;
    var iv = setInterval(function() {
      current += step;
      if (current >= targetVol) {
        audio.volume = targetVol;
        clearInterval(iv);
        if (cb) cb();
      } else {
        audio.volume = current;
      }
    }, FADE_DURATION / FADE_STEPS);
    return iv;
  }

  function fadeOut(audio, cb) {
    if (!audio) { if (cb) cb(); return null; }
    var startVol = audio.volume;
    if (startVol <= 0) { audio.pause(); if (cb) cb(); return null; }
    var step = startVol / FADE_STEPS;
    var current = startVol;
    var iv = setInterval(function() {
      current -= step;
      if (current <= 0) {
        audio.volume = 0;
        audio.pause();
        clearInterval(iv);
        if (cb) cb();
      } else {
        audio.volume = current;
      }
    }, FADE_DURATION / FADE_STEPS);
    return iv;
  }

  function createLoopAudio(config) {
    if (!config || !config.src) return null;
    try {
      var a = new Audio(config.src);
      a.loop = true;
      a.volume = 0;
      return a;
    } catch(e) { return null; }
  }

  function capPlayback(audio, onStop) {
    if (!audio) return;
    try {
      window.setTimeout(function() {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch(e) {}
        if (onStop) {
          try { onStop(); } catch(e) {}
        }
      }, MAX_PLAY_MS);
    } catch(e) {}
  }

  function updateLoopVolume(audio, config) {
    if (!audio || !config) return;
    try { audio.volume = effectiveVolume(config); } catch(e) {}
  }

  function soundscapeTargetVolume(baseVol) {
    var raw = Math.max(0, Math.min(1, typeof baseVol === 'number' ? baseVol : 0.5));
    var target = raw * (_catVol.ambient !== undefined ? _catVol.ambient : 0.7) * _masterVol;
    if (_muted) target = 0;
    return target;
  }

  function oneShotTemplate(src) {
    if (!src) return null;
    if (_oneShotTemplates[src]) return _oneShotTemplates[src];
    try {
      var a = new Audio(src);
      a.preload = 'metadata';
      _oneShotTemplates[src] = a;
      return a;
    } catch(e) { return null; }
  }

  function createOneShotAudio(config) {
    var template = oneShotTemplate(config && config.src);
    if (!template) return null;
    try {
      var a = template.cloneNode(true);
      a.preload = 'metadata';
      return a;
    } catch(e) {
      try {
        var fallback = new Audio(config.src);
        fallback.preload = 'metadata';
        return fallback;
      } catch(err) { return null; }
    }
  }

  function stopMatchingOneShots(predicate) {
    _liveOneShots.slice().forEach(function(entry) {
      if (!predicate(entry)) return;
      try { if (entry.timer) window.clearTimeout(entry.timer); } catch(e) {}
      try { entry.audio.pause(); } catch(e) {}
      try { entry.audio.currentTime = 0; } catch(e) {}
      try { entry.cleanup(); } catch(e) {}
    });
  }

  var mgr = {
    play: function(soundId) {
      try {
        var config = window.AUDIO_CONFIG && AUDIO_CONFIG[soundId];
        if (!config || !config.src) return;
        var vol = effectiveVolume(config);
        if (vol <= 0) return;
        if (!_userInteracted) {
          if (_pendingOneShots.indexOf(soundId) < 0) _pendingOneShots.push(soundId);
          if (_pendingOneShots.length > 8) _pendingOneShots.shift();
          return;
        }
        if (config.category === 'ui') stopMatchingOneShots(function(entry) { return entry.category === 'ui'; });
        else stopMatchingOneShots(function(entry) { return entry.soundId === soundId; });
        var now = Date.now();
        if (_throttleMap[soundId] && now - _throttleMap[soundId] < THROTTLE_MS) return;
        _throttleMap[soundId] = now;
        if (!_activeOneShots[soundId]) _activeOneShots[soundId] = 0;
        if (_activeOneShots[soundId] >= MAX_CONCURRENT) return;
        _activeOneShots[soundId]++;
        var cleaned = false;
        var entry = null;
        function cleanup() {
          if (cleaned) return;
          cleaned = true;
          _activeOneShots[soundId] = Math.max(0, (_activeOneShots[soundId] || 1) - 1);
          _liveOneShots = _liveOneShots.filter(function(x) { return x !== entry; });
        }
        var a = createOneShotAudio(config);
        if (!a) { cleanup(); return; }
        a.volume = vol;
        try { a.currentTime = 0; } catch(e) {}
        entry = { soundId: soundId, category: config.category || 'misc', audio: a, cleanup: cleanup, timer: null };
        _liveOneShots.push(entry);
        a.addEventListener('ended', cleanup);
        a.addEventListener('error', cleanup);
        var playMs = Math.max(250, config.maxPlayMs || MAX_PLAY_MS);
        a.play().then(function() {
          entry.timer = window.setTimeout(function() {
            try {
              a.pause();
              a.currentTime = 0;
            } catch(e) {}
            cleanup();
          }, playMs);
        }).catch(cleanup);
      } catch(e) {}
    },

    playMusic: function(soundId) {
      try {
        if (!_userInteracted) { _pendingMusic = soundId; return; }
        if (soundId === _currentMusicId && _currentMusic) return;
        var config = window.AUDIO_CONFIG && AUDIO_CONFIG[soundId];
        if (!config || !config.src) { mgr.stopMusic(); return; }
        var vol = effectiveVolume(config);
        var newAudio = createLoopAudio(config);
        if (!newAudio) return;
        var oldMusic = _currentMusic;
        _currentMusic = newAudio;
        _currentMusicId = soundId;
        newAudio.play().then(function() { fadeIn(newAudio, vol); }).catch(function() {});
        fadeOut(oldMusic);
      } catch(e) {}
    },

    stopMusic: function() {
      try {
        fadeOut(_currentMusic);
        _currentMusic = null;
        _currentMusicId = null;
      } catch(e) {}
    },

    setAmbient: function(soundId) {
      try {
        if (!_userInteracted) { _pendingAmbient = soundId; return; }
        if (_soundscapeLayers.length > 0) mgr.clearSoundscape();
        if (soundId === _currentAmbientId && _currentAmbient) return;
        var config = window.AUDIO_CONFIG && AUDIO_CONFIG[soundId];
        if (!config || !config.src) {
          fadeOut(_currentAmbient);
          _currentAmbient = null;
          _currentAmbientId = soundId;
          return;
        }
        var vol = effectiveVolume(config);
        var newAudio = createLoopAudio(config);
        if (!newAudio) return;
        var oldAmbient = _currentAmbient;
        _currentAmbient = newAudio;
        _currentAmbientId = soundId;
        newAudio.play().then(function() { fadeIn(newAudio, vol); }).catch(function() {});
        fadeOut(oldAmbient);
      } catch(e) {}
    },

    setWeatherAmbient: function(soundId) {
      try {
        if (!_userInteracted) { _pendingWeatherAmbient = soundId; return; }
        if (soundId === _currentWeatherAmbientId && _currentWeatherAmbient) return;
        if (!soundId) {
          fadeOut(_currentWeatherAmbient);
          _currentWeatherAmbient = null;
          _currentWeatherAmbientId = null;
          return;
        }
        var config = window.AUDIO_CONFIG && AUDIO_CONFIG[soundId];
        if (!config || !config.src) {
          fadeOut(_currentWeatherAmbient);
          _currentWeatherAmbient = null;
          _currentWeatherAmbientId = soundId;
          return;
        }
        var vol = effectiveVolume(config);
        var newAudio = createLoopAudio(config);
        if (!newAudio) return;
        var oldWeather = _currentWeatherAmbient;
        _currentWeatherAmbient = newAudio;
        _currentWeatherAmbientId = soundId;
        newAudio.play().then(function() { fadeIn(newAudio, vol); }).catch(function() {});
        fadeOut(oldWeather);
      } catch(e) {}
    },

    resolveLocationAmbient: function(loc) {
      if (!loc || !window.AMBIENT_LOCATION_MAP) return 'ambient.silence';
      var type = (loc.type || '').toLowerCase();
      if (AMBIENT_LOCATION_MAP[type]) {
        var mapped = AMBIENT_LOCATION_MAP[type];
        if (mapped === 'ambient.garage') return Math.random() < 0.5 ? 'ambient.garage1' : 'ambient.garage2';
        return mapped;
      }
      var detail = ((loc.ambientDetail || '') + ' ' + (loc.name || '') + ' ' + (loc.description || '')).toLowerCase();
      var keys = Object.keys(AMBIENT_LOCATION_MAP);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] !== 'default' && detail.indexOf(keys[i]) >= 0) {
          var mapped = AMBIENT_LOCATION_MAP[keys[i]];
          if (mapped === 'ambient.garage') return Math.random() < 0.5 ? 'ambient.garage1' : 'ambient.garage2';
          return mapped;
        }
      }
      return AMBIENT_LOCATION_MAP['default'] || 'ambient.silence';
    },

    resolveWeatherAmbient: function(weather) {
      if (!weather || !window.AMBIENT_WEATHER_MAP) return null;
      var cond = (weather.condition || '').toLowerCase();
      if (AMBIENT_WEATHER_MAP.hasOwnProperty(cond)) return AMBIENT_WEATHER_MAP[cond];
      var keys = Object.keys(AMBIENT_WEATHER_MAP);
      for (var i = 0; i < keys.length; i++) {
        if (cond.indexOf(keys[i]) >= 0) return AMBIENT_WEATHER_MAP[keys[i]];
      }
      var precip = (weather.precipitation || '').toLowerCase();
      if (precip && precip !== 'none' && AMBIENT_WEATHER_MAP.hasOwnProperty(precip)) return AMBIENT_WEATHER_MAP[precip];
      if (weather.thunder || weather.lightning) return 'ambient.storm';
      var wind = (weather.wind || '').toLowerCase();
      if (wind.indexOf('gust') >= 0 || wind.indexOf('wind') >= 0 || wind.indexOf('gale') >= 0) return 'ambient.wind';
      return null;
    },

    resolveWorldMusic: function(world) {
      var text = ((world && (world.concept || world.title || world.name || world.id)) || '').toLowerCase();
      if (text.indexOf('lost boys') >= 0 || text.indexOf('the lost boys') >= 0) return 'music.lostboys';
      return 'music.default';
    },

    setMasterVolume: function(v) {
      _masterVol = Math.max(0, Math.min(1, parseFloat(v) || 0));
      saveFloat('MasterVol', _masterVol);
      mgr._updateLoopVolumes();
    },

    setCategoryVolume: function(cat, v) {
      if (!_catVol.hasOwnProperty(cat)) return;
      _catVol[cat] = Math.max(0, Math.min(1, parseFloat(v) || 0));
      saveFloat('Vol_' + cat, _catVol[cat]);
      mgr._updateLoopVolumes();
    },

    getMasterVolume: function() { return _masterVol; },
    getCategoryVolume: function(cat) { return _catVol[cat] !== undefined ? _catVol[cat] : 1; },
    isMuted: function() { return _muted; },

    mute: function() { onInteract(); _muted = true; saveBool('Muted', true); mgr._updateLoopVolumes(); return _muted; },
    unmute: function() { onInteract(); _muted = false; saveBool('Muted', false); mgr._updateLoopVolumes(); return _muted; },
    toggleMute: function() { onInteract(); if (_muted) mgr.unmute(); else mgr.mute(); return _muted; },
    unlock: function() { onInteract(); return _userInteracted; },
    activate: function() { onInteract(); if (_muted) mgr.unmute(); mgr._updateLoopVolumes(); return !_muted; },
    isUnlocked: function() { return _userInteracted; },

    isSettingsOpen: function() { return _settingsOpen; },
    toggleSettings: function() { _settingsOpen = !_settingsOpen; },

    clearSoundscape: function() {
      _soundscapeFadeTimers.forEach(function(t) { clearInterval(t); });
      _soundscapeFadeTimers = [];
      _soundscapeLayers.forEach(function(layer) {
        try { if (layer.repeatTimer) window.clearTimeout(layer.repeatTimer); } catch(e) {}
        layer.stopped = true;
        try { layer.audio.pause(); } catch(e) {}
      });
      _soundscapeLayers = [];
      _soundscapeContextHash = null;
    },

    restoreSoundscapeFallback: function() {
      var ambient = _soundscapeFallbackAmbient;
      var weather = _soundscapeFallbackWeather;
      _soundscapeFallbackAmbient = null;
      _soundscapeFallbackWeather = null;
      if (ambient) mgr.setAmbient(ambient);
      if (weather !== undefined) mgr.setWeatherAmbient(weather);
    },

    setSoundscape: function(manifest) {
      try {
        if (!manifest || !manifest.layers || manifest.layers.length === 0) {
          mgr.clearSoundscape();
          return;
        }
        _soundscapeFallbackAmbient = manifest.fallbackAmbient || null;
        _soundscapeFallbackWeather = manifest.hasOwnProperty('fallbackWeather') ? manifest.fallbackWeather : undefined;
        if (!_userInteracted) { _pendingSoundscape = manifest; return; }
        if (manifest.contextHash === _soundscapeContextHash && _soundscapeLayers.length > 0) return;

        _soundscapeFadeTimers.forEach(function(t) { clearInterval(t); });
        _soundscapeFadeTimers = [];

        fadeOut(_currentAmbient);
        _currentAmbient = null;
        _currentAmbientId = null;
        fadeOut(_currentWeatherAmbient);
        _currentWeatherAmbient = null;
        _currentWeatherAmbientId = null;

        var oldLayers = _soundscapeLayers.slice();
        oldLayers.forEach(function(layer) {
          try { if (layer.repeatTimer) window.clearTimeout(layer.repeatTimer); } catch(e) {}
          layer.stopped = true;
          var startVol = layer.audio.volume;
          if (startVol <= 0) { layer.audio.pause(); return; }
          var step = startVol / SOUNDSCAPE_FADE_STEPS;
          var cur = startVol;
          var iv = setInterval(function() {
            cur -= step;
            if (cur <= 0) {
              layer.audio.volume = 0;
              layer.audio.pause();
              clearInterval(iv);
            } else {
              layer.audio.volume = cur;
            }
          }, SOUNDSCAPE_FADE_MS / SOUNDSCAPE_FADE_STEPS);
          _soundscapeFadeTimers.push(iv);
        });

        var newLayers = [];
        manifest.layers.forEach(function(layerDef) {
          if (!layerDef.soundUrl) return;
          try {
            var a = new Audio(layerDef.soundUrl);
            a.preload = 'metadata';
            a.loop = layerDef.loop !== false;
            a.volume = 0;
            var baseVol = typeof layerDef.volume === 'number' ? layerDef.volume : 0.5;
            var targetVol = soundscapeTargetVolume(baseVol);
            var entry = { audio: a, type: layerDef.type, freesoundId: layerDef.freesoundId, baseVol: baseVol, targetVol: targetVol, repeatTimer: null, stopped: false };
            if (layerDef.loop === false) {
              a.addEventListener('ended', function() {
                if (entry.stopped) return;
                var delay = Math.max(30000, Math.min(600000, Number(layerDef.repeatDelayMs || 180000)));
                try { if (entry.repeatTimer) window.clearTimeout(entry.repeatTimer); } catch(e) {}
                entry.repeatTimer = window.setTimeout(function() {
                  if (entry.stopped || _soundscapeLayers.indexOf(entry) < 0) return;
                  try {
                    a.currentTime = 0;
                    a.volume = soundscapeTargetVolume(entry.baseVol);
                    a.play().catch(function() {});
                  } catch(e) {}
                }, delay);
              });
            }
            newLayers.push(entry);
            a.play().then(function() {
              var step = targetVol / SOUNDSCAPE_FADE_STEPS;
              var cur = 0;
              var iv = setInterval(function() {
                cur += step;
                if (cur >= targetVol) {
                  a.volume = targetVol;
                  clearInterval(iv);
                } else {
                  a.volume = cur;
                }
              }, SOUNDSCAPE_FADE_MS / SOUNDSCAPE_FADE_STEPS);
              _soundscapeFadeTimers.push(iv);
            }).catch(function() {
              _soundscapeLayers = _soundscapeLayers.filter(function(layer) { return layer.audio !== a; });
              if (_soundscapeLayers.length === 0) mgr.restoreSoundscapeFallback();
            });
          } catch(e) {}
        });

        _soundscapeLayers = newLayers;
        _soundscapeContextHash = manifest.contextHash;
        if (newLayers.length === 0) mgr.restoreSoundscapeFallback();
      } catch(e) {}
    },

    hasSoundscape: function() {
      return _soundscapeLayers.length > 0;
    },

    _updateLoopVolumes: function() {
      if (_currentMusic && _currentMusicId) {
        var mc = window.AUDIO_CONFIG && AUDIO_CONFIG[_currentMusicId];
        if (mc) updateLoopVolume(_currentMusic, mc);
      }
      if (_currentAmbient && _currentAmbientId) {
        var ac = window.AUDIO_CONFIG && AUDIO_CONFIG[_currentAmbientId];
        if (ac) updateLoopVolume(_currentAmbient, ac);
      }
      if (_currentWeatherAmbient && _currentWeatherAmbientId) {
        var wc = window.AUDIO_CONFIG && AUDIO_CONFIG[_currentWeatherAmbientId];
        if (wc) updateLoopVolume(_currentWeatherAmbient, wc);
      }
      _soundscapeLayers.forEach(function(layer) {
        try {
          var targetVol = soundscapeTargetVolume(layer.baseVol);
          layer.targetVol = targetVol;
          layer.audio.volume = targetVol;
        } catch(e) {}
      });
    }
  };

  return mgr;
})();
