import { useEffect, useRef, useState, useCallback } from 'react';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function formatTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const Icon = {
  play: <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>,
  pause: <svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>,
  vol: <svg viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z" /></svg>,
  mute: <svg viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3zm13.59 2L19 9.41 17.59 8 15 10.59 12.41 8 11 9.41 13.59 12 11 14.59 12.41 16 15 13.41 17.59 16 19 14.59z" /></svg>,
  full: <svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></svg>,
  fullExit: <svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" /></svg>,
  settings: <svg viewBox="0 0 24 24"><path d="M19.14 12.94a7.5 7.5 0 0 0 .06-.94 7.5 7.5 0 0 0-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7 7 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.74 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.5 7.5 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96a7 7 0 0 0 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" /></svg>,
  note: <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" /></svg>,
};

export default function MediaPlayer({ type, src, title, onError }) {
  const isAudio = type === 'audio';
  const mediaRef = useRef(null);
  const playerRef = useRef(null);
  const hideTimer = useRef(null);

  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(isAudio ? false : true);
  const [rate, setRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [hoverRatio, setHoverRatio] = useState(0);

  const seekRef = useRef(null);
  const volRef = useRef(null);

  const togglePlay = useCallback(() => {
    const m = mediaRef.current;
    if (!m) return;
    if (m.paused) m.play().catch(() => {});
    else m.pause();
  }, []);

  const toggleMute = useCallback(() => {
    const m = mediaRef.current;
    if (!m) return;
    if (m.muted || m.volume === 0) {
      m.muted = false;
      if (m.volume === 0) m.volume = 1;
    } else {
      m.muted = true;
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (playerRef.current?.requestFullscreen) {
      playerRef.current.requestFullscreen();
    } else if (mediaRef.current?.webkitEnterFullscreen) {
      mediaRef.current.webkitEnterFullscreen();
    }
  }, []);

  const ratioFromEvent = (el, clientX) => {
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const seekTo = useCallback((clientX) => {
    const m = mediaRef.current;
    if (!m || !m.duration) return;
    m.currentTime = ratioFromEvent(seekRef.current, clientX) * m.duration;
  }, []);

  const setVolFromEvent = useCallback((clientX) => {
    const m = mediaRef.current;
    if (!m) return;
    const v = ratioFromEvent(volRef.current, clientX);
    m.volume = v;
    m.muted = false;
  }, []);

  useEffect(() => {
    if (!scrubbing) return;
    const move = (e) => seekTo(e.clientX);
    const up = () => setScrubbing(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [scrubbing, seekTo]);

  const [volDragging, setVolDragging] = useState(false);
  useEffect(() => {
    if (!volDragging) return;
    const move = (e) => setVolFromEvent(e.clientX);
    const up = () => setVolDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [volDragging, setVolFromEvent]);

  useEffect(() => {
    const m = mediaRef.current;
    if (!m) return;
    m.muted = isAudio ? false : true;
    m.play().catch(() => {});
  }, [src, isAudio]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === playerRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const wakeControls = useCallback(() => {
    if (isAudio) return;
    setControlsHidden(false);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      const m = mediaRef.current;
      if (m && !m.paused) {
        setControlsHidden(true);
        setMenuOpen(false);
      }
    }, 2600);
  }, [isAudio]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  useEffect(() => {
    if (isAudio) return;
    const handler = (e) => {
      const tag = (document.activeElement || {}).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const m = mediaRef.current;
      if (!m) return;
      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          wakeControls();
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'm':
          toggleMute();
          break;
        case 'arrowright':
          m.currentTime = Math.min(m.duration || 0, m.currentTime + 5);
          wakeControls();
          break;
        case 'arrowleft':
          m.currentTime = Math.max(0, m.currentTime - 5);
          wakeControls();
          break;
        case 'arrowup':
          e.preventDefault();
          m.volume = Math.min(1, m.volume + 0.05);
          m.muted = false;
          break;
        case 'arrowdown':
          e.preventDefault();
          m.volume = Math.max(0, m.volume - 0.05);
          break;
        default:
          break;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isAudio, togglePlay, toggleMute, toggleFullscreen, wakeControls]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e) => {
      if (playerRef.current && !playerRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [menuOpen]);

  const onTimeUpdate = (e) => setCurrent(e.target.currentTime);
  const onLoadedMeta = (e) => setDuration(e.target.duration);
  const onDurationChange = (e) => setDuration(e.target.duration);
  const onVolumeChange = (e) => {
    setVolume(e.target.volume);
    setMuted(e.target.muted || e.target.volume === 0);
  };
  const onProgress = (e) => {
    const m = e.target;
    try {
      if (m.buffered.length && m.duration) {
        setBuffered((m.buffered.end(m.buffered.length - 1) / m.duration) * 100);
      }
    } catch {
      /* ignore */
    }
  };
  const onPlay = () => {
    setPlaying(true);
    wakeControls();
  };
  const onPause = () => {
    setPlaying(false);
    setControlsHidden(false);
    clearTimeout(hideTimer.current);
  };

  const pct = duration ? (current / duration) * 100 : 0;
  const volPct = (muted ? 0 : volume) * 100;

  const seekBar = (
    <div
      className={`mp-seek${scrubbing ? ' is-scrubbing' : ''}`}
      ref={seekRef}
      onPointerDown={(e) => {
        setScrubbing(true);
        seekTo(e.clientX);
      }}
      onPointerMove={(e) => setHoverRatio(ratioFromEvent(seekRef.current, e.clientX))}
    >
      <div className="mp-seek-tooltip" style={{ left: `${hoverRatio * 100}%` }}>
        {formatTime(hoverRatio * duration)}
      </div>
      <div className="mp-seek-track">
        <div className="mp-seek-buffered" style={{ width: `${buffered}%` }} />
        <div className="mp-seek-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="mp-seek-thumb" style={{ left: `${pct}%` }} />
    </div>
  );

  const playButton = (
    <button className="mp-btn" onClick={togglePlay} title="Play/Pause (k)">
      {playing ? Icon.pause : Icon.play}
    </button>
  );

  const volumeControl = (
    <div className="mp-volume">
      <button className="mp-btn" onClick={toggleMute} title="Mute (m)">
        {muted ? Icon.mute : Icon.vol}
      </button>
      <div className="mp-volume-slider">
        <div
          className="mp-vol-track"
          ref={volRef}
          onPointerDown={(e) => {
            setVolDragging(true);
            setVolFromEvent(e.clientX);
          }}
        >
          <div className="mp-vol-fill" style={{ width: `${volPct}%` }} />
          <div className="mp-vol-thumb" style={{ left: `${volPct}%` }} />
        </div>
      </div>
    </div>
  );

  const timeDisplay = (
    <div className="mp-time">
      <span>{formatTime(current)}</span>
      <span className="mp-time-sep">/</span>
      <span>{formatTime(duration)}</span>
    </div>
  );

  const settingsMenu = (
    <div className="mp-menu-wrap">
      <button
        className="mp-btn"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((o) => !o);
        }}
        title="Playback speed"
      >
        {Icon.settings}
      </button>
      <div className={`mp-menu${menuOpen ? ' show' : ''}`}>
        <div className="mp-menu-label">Playback speed</div>
        {SPEEDS.map((s) => (
          <div
            key={s}
            className={`mp-menu-item${rate === s ? ' is-selected' : ''}`}
            onClick={() => {
              if (mediaRef.current) mediaRef.current.playbackRate = s;
              setRate(s);
              setMenuOpen(false);
            }}
          >
            <span>{s === 1 ? 'Normal' : `${s}×`}</span>
          </div>
        ))}
      </div>
    </div>
  );

  if (isAudio) {
    return (
      <div className={`media-player is-audio${playing ? ' is-playing' : ' is-paused'}${muted ? ' is-muted' : ''}`} ref={playerRef}>
        <audio
          ref={mediaRef}
          src={src}
          preload="metadata"
          onPlay={onPlay}
          onPause={onPause}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMeta}
          onDurationChange={onDurationChange}
          onVolumeChange={onVolumeChange}
          onProgress={onProgress}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => setBuffering(false)}
          onCanPlay={() => setBuffering(false)}
          onError={onError}
        />
        <div className="mp-audio-head">
          <div className="mp-art">
            {Icon.note}
          </div>
          <div className="mp-audio-meta">
            <div className="mp-audio-title">{title || 'Audio'}</div>
            <div className="mp-audio-sub">Audio file</div>
          </div>
        </div>
        <div className="mp-controls">
          {seekBar}
          <div className="mp-row">
            {playButton}
            {timeDisplay}
            <div className="mp-spacer" />
            {volumeControl}
            {settingsMenu}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`media-player is-video${playing ? ' is-playing' : ' is-paused'}${muted ? ' is-muted' : ''}${buffering ? ' is-buffering' : ''}${controlsHidden ? ' is-hidden-cursor' : ''}`}
      ref={playerRef}
      onMouseMove={wakeControls}
      onMouseLeave={() => {
        if (mediaRef.current && !mediaRef.current.paused) setControlsHidden(true);
      }}
    >
      <video
        ref={mediaRef}
        src={src}
        playsInline
        preload="metadata"
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        onPlay={onPlay}
        onPause={onPause}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMeta}
        onDurationChange={onDurationChange}
        onVolumeChange={onVolumeChange}
        onProgress={onProgress}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onError={onError}
      />

      <div className="mp-poster-play" onClick={togglePlay}>
        <div className="mp-poster-btn">{Icon.play}</div>
      </div>

      <div className="mp-buffering"><div className="mp-spinner" /></div>

      <div className={`mp-controls${controlsHidden ? ' is-hidden' : ''}`}>
        {seekBar}
        <div className="mp-row">
          {playButton}
          {volumeControl}
          {timeDisplay}
          <div className="mp-spacer" />
          {settingsMenu}
          <button className="mp-btn" onClick={toggleFullscreen} title="Fullscreen (f)">
            {fullscreen ? Icon.fullExit : Icon.full}
          </button>
        </div>
      </div>
    </div>
  );
}
