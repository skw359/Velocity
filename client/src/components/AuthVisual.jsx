// Decorative art panel for the auth pages, drawn entirely in CSS (no external images).

const MOCK_PANELS = [
  {
    label: 'nas-primary',
    rows: [
      { w: 62, kind: 'folder' },
      { w: 45, kind: 'folder' },
      { w: 71, kind: 'file' },
      { w: 38, kind: 'file' },
      { w: 55, kind: 'file' },
    ],
  },
  {
    label: 'archive',
    rows: [
      { w: 52, kind: 'folder' },
      { w: 68, kind: 'file' },
      { w: 41, kind: 'file' },
      { w: 59, kind: 'file' },
    ],
  },
  {
    label: 'media',
    rows: [
      { w: 47, kind: 'folder' },
      { w: 63, kind: 'file' },
      { w: 35, kind: 'file' },
    ],
  },
];

export default function AuthVisual({ headline, sub }) {
  return (
    <div className="visual-side">
      <div className="visual-wash" aria-hidden="true" />

      <div className="visual-stack" aria-hidden="true">
        {MOCK_PANELS.map((panel, i) => (
          <div className={`mock-panel mock-panel-${i + 1}`} key={panel.label}>
            <div className="mock-chrome">
              <span className="mock-dot" />
              <span className="mock-label">{panel.label}</span>
              <span className="mock-lock" />
            </div>
            <div className="mock-rows">
              {panel.rows.map((row, r) => (
                <div className="mock-row" key={r}>
                  <span className={`mock-icon mock-icon-${row.kind}`} />
                  <span className="mock-line" style={{ width: `${row.w}%` }} />
                  <span className="mock-meta" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {headline && (
        <div className="visual-text">
          <h1>{headline}</h1>
          {sub && <p className="visual-sub">{sub}</p>}
        </div>
      )}
    </div>
  );
}
