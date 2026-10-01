// 內建 SVG 圖示（16×16，currentColor）
const Icons = (() => {
  const s = body => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const P = {
    bgtone: s('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 13.5l11-11v9.5a1.5 1.5 0 0 1-1.5 1.5z" fill="currentColor" stroke="none"/>'),
    blend: s('<circle cx="6" cy="8" r="4"/><circle cx="10" cy="8" r="4"/>'),
    clip: s('<path d="M4 2.5v6a2 2 0 0 0 2 2h7"/><path d="M10.5 8l2.5 2.5-2.5 2.5"/>'),
    timeline: s('<path d="M2 4h7M5 8h9M3 12h6"/><path d="M11 2.5v3M4 10.5v3"/>'),
    wrench: s('<path d="M10.3 2.2a3.4 3.4 0 0 0-3.6 4.5L2.3 11.1a1.4 1.4 0 0 0 2 2l4.4-4.4a3.4 3.4 0 0 0 4.5-3.6l-2 2-1.8-.5-.5-1.8z"/>'),
    dropper: s('<path d="M10.5 2.5l3 3-1.6 1.6-3-3zM9.3 3.9l2.8 2.8-6.3 6.3H3v-2.8z"/>'),
    root: s('<circle cx="8" cy="8" r="5.5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/>'),
    image: s('<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="M3 12l3.5-3.5 2.5 2.5 2-2 2.5 2.5"/>'),
    folder: s('<path d="M1.8 4.2h4.4l1.4 1.4h6.6v6.9H1.8z" fill="currentColor" fill-opacity=".25"/>'),
    rotate: s('<path d="M12.5 5.5A5 5 0 1 0 13 9"/><path d="M13 2.5v3h-3"/>'),
    wave: s('<path d="M1.5 5c2-2 3 2 5 0s3-2 5 0 2 1 3 0M1.5 10c2-2 3 2 5 0s3-2 5 0 2 1 3 0"/>'),
    eye: s('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
    eyeOff: s('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" opacity=".4"/><path d="M2.5 13.5l11-11"/>'),
    plus: s('<path d="M8 3v10M3 8h10"/>'),
    layers: s('<path d="M8 2l6 3.2-6 3.2-6-3.2z"/><path d="M2 8.4l6 3.2 6-3.2"/><path d="M2 11.2l6 3.2 6-3.2" opacity=".5"/>'),
    template: s('<circle cx="8" cy="5" r="3"/><path d="M8 8v3M4 14l4-3 4 3M3.5 10.5h9"/>'),
    trash: s('<path d="M2.5 4.5h11M6 4.5V2.8h4v1.7M4 4.5l.7 9h6.6l.7-9"/>'),
    undo: s('<path d="M5 6.5H10a3.5 3.5 0 0 1 0 7H6"/><path d="M7.5 3.5L4.5 6.5l3 3"/>'),
    redo: s('<path d="M11 6.5H6a3.5 3.5 0 0 0 0 7h4"/><path d="M8.5 3.5l3 3-3 3"/>'),
    play: s('<path d="M5 3l8 5-8 5z" fill="currentColor"/>'),
    pause: s('<path d="M5 3v10M11 3v10" stroke-width="2.4"/>'),
    prev: s('<path d="M4 3v10M12 3L6 8l6 5z" fill="currentColor"/>'),
    next: s('<path d="M12 3v10M4 3l6 5-6 5z" fill="currentColor"/>'),
    cursor: s('<path d="M3.5 2l8.5 7-3.8.4 2.2 4.1-1.6.8-2.1-4.2-3.2 2.4z" fill="currentColor" fill-opacity=".2"/>'),
    pin: s('<circle cx="8" cy="6" r="3.3"/><path d="M8 9.3V15"/>'),
    brush: s('<path d="M13.5 2.5L7 9"/><path d="M6.8 9.2c-1.8-.4-3.3.8-3.3 2.6 0 1.1-.6 1.6-1.5 1.8 3.3 1.2 6.2-.6 4.8-4.4z" fill="currentColor" fill-opacity=".3"/>'),
    eraser: s('<path d="M9.5 2.8l3.7 3.7-6.7 6.7H3.2L1.8 11.8z"/><path d="M6 6.3l3.7 3.7M8 13.2h6"/>'),
    lasso: s('<path d="M3 3.5l9 1.5-1.5 5 2.5 3.5-7-1.5-4 1z" stroke-dasharray="2 1.6"/>'),
    mesh: s('<path d="M2 2h12v12H2zM2 8h12M8 2v12M2 2l12 12"/>'),
    fit: s('<path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/>'),
    chevR: s('<path d="M6 4l4 4-4 4"/>'),
    chevD: s('<path d="M4 6l4 4 4-4"/>'),
    close: s('<path d="M4 4l8 8M12 4l-8 8"/>'),
    open: s('<path d="M1.8 4.2h4.4l1.4 1.4h6.6v6.9H1.8z"/><path d="M8 7.3v4M6 9.3h4"/>'),
    warn: s('<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.5v.2"/>'),
    export: s('<path d="M8 2v8M4.5 6.5L8 10l3.5-3.5"/><path d="M2.5 11v2.5h11V11"/>'),
    region: s('<circle cx="8" cy="8" r="2.5" fill="currentColor"/><circle cx="8" cy="8" r="5" stroke-dasharray="1.6 1.6"/>'),
    lock: s('<rect x="3" y="7" width="10" height="7" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
    transform: s('<rect x="3" y="3" width="10" height="10" stroke-dasharray="2 1.5"/><rect x="1.5" y="1.5" width="3" height="3" fill="currentColor"/><rect x="11.5" y="11.5" width="3" height="3" fill="currentColor"/><path d="M8 0.5v2"/>'),
    paint: s('<path d="M11 2l3 3-7 7H4v-3z"/><path d="M9.5 3.5l3 3"/><path d="M2 14.5h5"/>'),
    dot: s('<circle cx="8" cy="8" r="5" opacity=".35"/><circle cx="8" cy="8" r="2.6" fill="currentColor"/>'),
    dotOff: s('<circle cx="8" cy="8" r="5" stroke-dasharray="1.6 1.6"/>'),
    auto: s('<path d="M2.5 13.5l7-7"/><path d="M9.5 6.5l1.5-1.5 1 1-1.5 1.5z" fill="currentColor"/><path d="M11 1.5v2M13.5 4H11.5M12.8 2.2l-1 1M5 2v2M4 3h2M13 9v2M12 10h2"/>'),
    save: s('<path d="M2.5 2.5h9l2 2v9h-11z"/><path d="M5 2.5v3.5h5V2.5M5 13.5V9.5h6v4"/>'),
    depthpen: s('<path d="M11.2 1.8l3 3-8.4 8.4-4 1 1-4z"/><circle cx="4" cy="4" r="2.3" fill="currentColor" fill-opacity=".45"/>'),
    crop: s('<path d="M4 1.5V12h10.5"/><path d="M1.5 4H12v10.5"/>'),
    head: s('<circle cx="8" cy="7" r="5"/><path d="M4 12.5c1 1.6 2.4 2.3 4 2.3s3-.7 4-2.3"/><path d="M3.3 6.2c1.6-2.9 7.8-2.9 9.4 0" stroke-width="1.6"/>'),
    maskring: s('<circle cx="8" cy="8" r="5.5" stroke-width="2"/>'),
    chain: s('<rect x="1.8" y="5.8" width="6.2" height="4.4" rx="2.2"/><rect x="8" y="5.8" width="6.2" height="4.4" rx="2.2"/>'),
    pen: s('<path d="M11.2 1.8l3 3-8.4 8.4-4 1 1-4z"/><path d="M9.6 3.4l3 3M2.8 10.2l3 3"/>'),
    mask: s('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/>'),
    cut: s('<circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M5.8 10L12 2.5M10.2 10L4 2.5"/>'),
  };
  function el(name, cls = '') {
    const e = document.createElement('span');
    e.className = 'ico ' + cls;
    e.innerHTML = P[name] || '';
    return e;
  }
  return { P, el };
})();
