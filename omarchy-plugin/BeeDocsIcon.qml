import QtQuick
import QtQuick.Shapes
import qs.Commons
import qs.Ui

// BeeDocs mark: a hexagon (the bee family crest, matching BeeClean) holding
// three text lines — documents in the hive. `warning` adds the kit's urgent
// badge for an unreachable server.
Item {
  id: root

  property real iconSize: Style.font.icon
  property color color: Color.foreground
  property color badgeColor: Color.urgent
  property bool warning: false

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize

  readonly property real stroke: Math.max(1.4, iconSize * 0.12)
  readonly property real cx: width / 2
  readonly property real cy: height / 2
  readonly property real r: iconSize * 0.46
  readonly property real sq: Math.sqrt(3) / 2
  readonly property real lineWidth: r * 0.95
  readonly property real lineStroke: Math.max(1.1, stroke * 0.7)

  Shape {
    anchors.fill: parent
    antialiasing: true
    preferredRendererType: Shape.CurveRenderer

    ShapePath {
      fillColor: "transparent"
      strokeColor: root.color
      strokeWidth: root.stroke
      capStyle: ShapePath.RoundCap
      joinStyle: ShapePath.RoundJoin

      startX: root.cx
      startY: root.cy - root.r
      PathLine { x: root.cx + root.r * root.sq; y: root.cy - root.r * 0.5 }
      PathLine { x: root.cx + root.r * root.sq; y: root.cy + root.r * 0.5 }
      PathLine { x: root.cx; y: root.cy + root.r }
      PathLine { x: root.cx - root.r * root.sq; y: root.cy + root.r * 0.5 }
      PathLine { x: root.cx - root.r * root.sq; y: root.cy - root.r * 0.5 }
      PathLine { x: root.cx; y: root.cy - root.r }
    }

    ShapePath {
      fillColor: "transparent"
      strokeColor: root.color
      strokeWidth: root.lineStroke
      capStyle: ShapePath.RoundCap

      startX: root.cx - root.lineWidth / 2
      startY: root.cy - root.r * 0.32
      PathLine { x: root.cx + root.lineWidth / 2; y: root.cy - root.r * 0.32 }
      PathMove { x: root.cx - root.lineWidth / 2; y: root.cy }
      PathLine { x: root.cx + root.lineWidth / 2; y: root.cy }
      PathMove { x: root.cx - root.lineWidth / 2; y: root.cy + root.r * 0.32 }
      PathLine { x: root.cx + root.lineWidth * 0.15; y: root.cy + root.r * 0.32 }
    }
  }

  BorderSurface {
    visible: root.warning
    width: Math.max(7, parent.width * 0.42)
    height: width
    radius: width / 2
    color: root.badgeColor
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    borderSpec: Border.flat(Color.popups.background, 1)

    Text {
      anchors.centerIn: parent
      text: "!"
      color: Color.background
      font.family: Style.font.family
      font.pixelSize: Math.max(6, parent.height * 0.72)
      font.bold: true
    }
  }
}
