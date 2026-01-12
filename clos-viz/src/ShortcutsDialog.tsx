interface ShortcutsDialogProps {
  onClose: () => void
}

export function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div className="shortcutsOverlay" onClick={handleOverlayClick}>
      <div className="shortcutsDialog">
        <div className="shortcutsHeader">
          <h2>Keyboard Shortcuts</h2>
          <button className="shortcutsClose" onClick={onClose} title="Close (K or ESC)">
            &times;
          </button>
        </div>

        <div className="shortcutsBody">
          <section className="shortcutsSection">
            <h3>Keyboard</h3>
            <table className="shortcutsTable">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Action</th>
                  <th>Context</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><kbd>ESC</kbd></td>
                  <td>Cancel route selection</td>
                  <td>When route is pending</td>
                </tr>
                <tr>
                  <td><kbd>C</kbd></td>
                  <td>Toggle relay mode</td>
                  <td>Anytime</td>
                </tr>
                <tr>
                  <td><kbd>K</kbd></td>
                  <td>Toggle this help dialog</td>
                  <td>Anytime</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="shortcutsSection">
            <h3>Mouse Modifiers - Input Ports</h3>
            <table className="shortcutsTable">
              <thead>
                <tr>
                  <th>Modifier</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><kbd>⌘</kbd> + Click</td>
                  <td>Toggle input lock</td>
                </tr>
                <tr>
                  <td><kbd>⌘</kbd> + <kbd>⇧</kbd> + Click</td>
                  <td>Delete route</td>
                </tr>
                <tr>
                  <td><kbd>⌥</kbd> + Click</td>
                  <td>Highlight route owner</td>
                </tr>
                <tr>
                  <td><kbd>⌥</kbd> + Hover</td>
                  <td>Highlight entire chain (PropatchMD only)</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="shortcutsSection">
            <h3>Mouse Modifiers - Output Ports</h3>
            <table className="shortcutsTable">
              <thead>
                <tr>
                  <th>Modifier</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><kbd>⌘</kbd> + Click</td>
                  <td>Toggle output lock</td>
                </tr>
                <tr>
                  <td><kbd>⇧</kbd> + Click</td>
                  <td>Add to multicast route</td>
                </tr>
                <tr>
                  <td><kbd>⌥</kbd> + Click</td>
                  <td>Highlight route owner</td>
                </tr>
                <tr>
                  <td><kbd>⌥</kbd> + Hover</td>
                  <td>Highlight entire chain (PropatchMD only)</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>

        <div className="shortcutsFooter">
          <span className="shortcutsHint">Press <kbd>K</kbd> or <kbd>ESC</kbd> to close</span>
        </div>
      </div>
    </div>
  )
}
