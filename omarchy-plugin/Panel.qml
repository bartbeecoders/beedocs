import QtQuick
import QtQuick.Controls
import Quickshell.Io
import qs.Commons
import qs.Ui

// BeeDocs bar widget: pill icon + popup panel. The panel is the library's
// front porch — server status, full-text search over /api/search, and
// launchers for the workspace window; the workspace itself lives in a
// chromium app-mode window (see Service.qml for why nothing embeds here).
Panel {
  id: root
  moduleName: "bart.beedocs"
  ipcTarget: "bart.beedocs"
  manageIpc: false

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color rowFill: Style.selectedFillFor(foreground, Color.accent)

  property int selectedIndex: 0

  Service {
    id: docs
    settings: root.settings
  }

  readonly property string countsLine: {
    var c = docs.counts
    if (!c) return ""
    return c.books + " books · " + c.pages + " pages · " + c.diagrams + " diagrams · "
      + c.slideDecks + " decks · " + c.attachments + " files"
  }

  // U+E000/U+E001 mark matched terms in search snippets; render them bold.
  function styledSnippet(snippet) {
    var text = String(snippet || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    return text.replace(/\uE000/g, "<b>").replace(/\uE001/g, "</b>")
  }

  function moveSelection(delta) {
    if (docs.hits.length === 0) return
    selectedIndex = Math.max(0, Math.min(docs.hits.length - 1, selectedIndex + delta))
  }

  function openSelected() {
    if (docs.hits.length === 0) return
    var hit = docs.hits[Math.min(selectedIndex, docs.hits.length - 1)]
    docs.openHit(hit.url)
    root.close()
  }

  function openApp() {
    docs.openApp()
    root.close()
  }

  onOpenedChanged: {
    if (!opened) return
    docs.refresh()
    selectedIndex = 0
  }

  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function app(): string { docs.openApp(); return "ok" }
    function refresh(): string { docs.refresh(); return "ok" }
    function status(): string { return "BeeDocs · " + docs.statusText }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    tooltipText: "BeeDocs · " + docs.statusText
    iconComponent: Component {
      Item {
        BeeDocsIcon {
          anchors.centerIn: parent
          iconSize: Style.space(12)
          color: docs.online ? root.barForeground : Qt.darker(root.barForeground, 1.55)
          warning: !docs.online && !docs.checking
        }
      }
    }
    // The workspace window is the product; the search panel is the accessory.
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) root.toggle()
      else if (buttonCode === Qt.MiddleButton) docs.refresh()
      else docs.openApp()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    // The search field takes first focus so the panel opens ready to type;
    // the key catcher only fields keys while the input is hidden (offline).
    focusTarget: docs.online ? searchField : keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: searchField.activeFocus
      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveSelection(dy) }
      onActivateRequested: root.openSelected()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "/") { searchField.forceActiveFocus(); searchField.selectAll() }
        else if (t === "o" || t === "O") root.openApp()
        else if (t === "r" || t === "R") docs.refresh()
        else if ((t === "s" || t === "S") && docs.canStart) docs.startServer()
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

      Column {
        id: column
        width: panelFlick.width
        spacing: Style.space(10)

        PanelHero {
          width: parent.width
          title: "BeeDocs"
          meta: docs.statusText
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconOpacity: docs.online ? 1.0 : 0.5
          iconComponent: Component {
            BeeDocsIcon {
              iconSize: Style.font.display
              color: docs.online ? root.foreground : root.dim
              warning: !docs.online && !docs.checking
            }
          }
          trailingControl: Component {
            Row {
              spacing: Style.space(6)

              PanelActionButton {
                iconText: "󰏌"
                tooltipText: "Open BeeDocs window"
                foreground: root.foreground
                fontFamily: root.fontFamily
                enabled: docs.online
                onClicked: root.openApp()
              }

              PanelActionButton {
                iconText: "󰑐"
                tooltipText: "Check server"
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: docs.refresh()
              }
            }
          }
        }

        Text {
          visible: root.countsLine !== ""
          width: parent.width
          text: root.countsLine
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
        }

        TextField {
          id: searchField
          width: parent.width
          visible: docs.online
          placeholderText: "Search the library…"
          foreground: root.foreground
          font.family: root.fontFamily
          onActiveFocusChanged: if (activeFocus) selectAll()
          onTextChanged: debounce.restart()
          Keys.onDownPressed: root.moveSelection(1)
          Keys.onUpPressed: root.moveSelection(-1)
          Keys.onEscapePressed: root.close()
          onAccepted: root.openSelected()
        }

        Timer {
          id: debounce
          interval: 220
          onTriggered: { root.selectedIndex = 0; docs.search(searchField.text) }
        }

        Column {
          width: parent.width
          spacing: Style.space(2)
          visible: docs.online && docs.hits.length > 0

          Repeater {
            model: docs.hits

            delegate: Rectangle {
              id: hitRow
              required property var modelData
              required property int index

              width: parent.width
              implicitHeight: hitColumn.implicitHeight + Style.space(12)
              radius: Style.space(6)
              color: index === root.selectedIndex ? root.rowFill : "transparent"

              Column {
                id: hitColumn
                anchors.verticalCenter: parent.verticalCenter
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: Style.space(8)
                anchors.rightMargin: Style.space(8)
                spacing: Style.space(2)

                Row {
                  width: parent.width
                  spacing: Style.space(6)

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: String(hitRow.modelData.kind || "").toUpperCase()
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall - 2
                    font.letterSpacing: 0.5
                  }

                  Text {
                    text: hitRow.modelData.title || "(untitled)"
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                    width: Math.min(implicitWidth, parent.width * 0.62)
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    visible: !!hitRow.modelData.bookTitle
                    text: "· " + (hitRow.modelData.bookTitle || "")
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    elide: Text.ElideRight
                    width: Math.min(implicitWidth, parent.width * 0.34)
                  }
                }

                Text {
                  visible: !!hitRow.modelData.snippet
                  width: parent.width
                  text: root.styledSnippet(hitRow.modelData.snippet)
                  textFormat: Text.StyledText
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  wrapMode: Text.WordWrap
                  maximumLineCount: 2
                  elide: Text.ElideRight
                }
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onEntered: root.selectedIndex = hitRow.index
                onClicked: { docs.openHit(hitRow.modelData.url); root.close() }
              }
            }
          }
        }

        Text {
          visible: docs.online && !docs.searching && docs.query.trim() !== "" && docs.hits.length === 0
          width: parent.width
          text: "No matches for “" + docs.query + "”"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Column {
          width: parent.width
          spacing: Style.space(8)
          visible: !docs.online

          Text {
            width: parent.width
            text: docs.lastError !== "" ? docs.lastError : "BeeDocs is not reachable."
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Button {
            visible: docs.canStart
            text: "Start BeeDocs"
            foreground: root.foreground
            fontFamily: root.fontFamily
            bordered: true
            onClicked: { docs.startServer(); root.close() }
          }

          Text {
            visible: !docs.canStart
            width: parent.width
            text: "Set the widget's “Start command” (installed service) or “BeeDocs checkout” (dev repo) setting to get a start button here."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }
        }

        Text {
          width: parent.width
          visible: docs.online
          text: "Enter opens a result · click the bar icon for the workspace window"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall - 1
          wrapMode: Text.WordWrap
        }
      }
      }
    }
  }
}
