import QtQuick
import QtQuick.Controls
import QtQuick.Window
import net.asivery.AppLoad 1.0

// InkWise for reMarkable: the screen. All the work happens in the backend
// (inkwise-rm appload); this sends it requests and draws the state it sends back.
Rectangle {
    id: root
    color: "white"

    // Millimetres in pixels. Paper Pro: about 9 px/mm, Paper Pro Move: about 10.4.
    property real mm: Screen.pixelDensity > 6 ? Screen.pixelDensity : (Screen.width >= 1400 ? 9.0 : 10.4)
    readonly property real pad: 6 * mm
    readonly property int bodySize: Math.round(3.4 * mm)
    readonly property int smallSize: Math.round(2.8 * mm)
    readonly property string fontFamily: "Noto Sans"

    // The backend's state (see AppState in src/backend.ts).
    property var app: ({
        version: "", connected: false, librarian: false, syncing: false, progress: "",
        last: null, settings: { autoSyncMinutes: 30, location: "later" }, log: [],
        nextSyncAt: null, tokenMessage: ""
    })
    property bool loaded: false
    property bool editingToken: false
    // Times are shown as "5 min ago": the tablet's clock runs on UTC, so a clock time would be hours off.
    property real nowMs: Date.now()
    Timer {
        interval: 60000
        running: true
        repeat: true
        onTriggered: root.nowMs = Date.now()
    }

    signal close
    function unloading() {
        // With automatic sync on, the backend keeps running after the screen closes.
        if (loaded && !app.settings.autoSyncMinutes) backend.terminate();
    }

    AppLoad {
        id: backend
        applicationID: "inkwise"
        onMessageReceived: (type, contents) => {
            if (type !== 100) return;
            root.app = JSON.parse(contents);
            root.loaded = true;
            root.nowMs = Date.now();
            if (root.app.connected && root.app.tokenMessage === "Connected to Readwise.") root.editingToken = false;
        }
    }

    // "2026-10-08T23:02:00.000Z [sent] (yellow) text" -> "5 min ago   Sent (yellow): text"
    function logLine(line) {
        const space = line.indexOf(" ");
        const at = line.slice(0, space);
        const rest = line.slice(space + 1).replace(/^\[sent\] \(([^)]*)\) /, "Sent ($1): ").replace(/^\[([a-z_]+)\] \(([^)]*)\) /, "$1 ($2): ").replace(/^warning: /, "Warning: ");
        return (isNaN(Date.parse(at)) ? "" : ago(at) + "   ") + rest;
    }

    function send(type, body) { backend.sendMessage(type, JSON.stringify(body || {})); }
    Component.onCompleted: send(1)

    // "just now", "5 min ago", "2 hours ago", "yesterday", "3 days ago"
    function ago(iso) {
        if (!iso) return "";
        const mins = Math.floor((root.nowMs - Date.parse(iso)) / 60000);
        if (mins < 1) return "just now";
        if (mins < 60) return mins + " min ago";
        const hours = Math.floor(mins / 60);
        if (hours < 24) return hours === 1 ? "an hour ago" : hours + " hours ago";
        const days = Math.floor(hours / 24);
        return days === 1 ? "yesterday" : days + " days ago";
    }

    // "in a moment", "in 25 min", "in 2 hours"
    function fromNow(iso) {
        const mins = Math.ceil((Date.parse(iso) - root.nowMs) / 60000);
        if (mins <= 1) return "in a moment";
        if (mins < 60) return "in " + mins + " min";
        const hours = Math.round(mins / 60);
        return hours === 1 ? "in about an hour" : "in about " + hours + " hours";
    }

    // A tappable box. Filled black when `on`.
    component Choice: Rectangle {
        id: choice
        property string label
        property bool on: false
        signal tapped
        implicitWidth: choiceText.implicitWidth + 6 * root.mm
        implicitHeight: 11 * root.mm
        radius: 1.5 * root.mm
        color: on ? "black" : "white"
        border.color: enabled ? "black" : "#999999"
        border.width: Math.max(2, Math.round(0.4 * root.mm))
        Text {
            id: choiceText
            anchors.centerIn: parent
            text: choice.label
            font.family: root.fontFamily
            font.pixelSize: root.bodySize
            font.bold: choice.on
            color: choice.on ? "white" : (choice.enabled ? "black" : "#999999")
        }
        MouseArea {
            anchors.fill: parent
            onClicked: choice.tapped()
        }
    }

    component Heading: Text {
        font.family: root.fontFamily
        font.pixelSize: Math.round(3.8 * root.mm)
        font.bold: true
        color: "black"
    }

    component Body: Text {
        width: parent ? parent.width : 0
        wrapMode: Text.Wrap
        font.family: root.fontFamily
        font.pixelSize: root.bodySize
        color: "black"
    }

    component Rule: Rectangle {
        width: parent ? parent.width : 0
        height: Math.max(2, Math.round(0.3 * root.mm))
        color: "black"
    }

    Flickable {
        id: page
        anchors.fill: parent
        contentHeight: column.height + 2 * root.pad
        boundsBehavior: Flickable.StopAtBounds
        clip: true

        Column {
            id: column
            x: root.pad
            y: root.pad
            width: page.width - 2 * root.pad
            spacing: 4 * root.mm

            // Title row
            Item {
                width: parent.width
                height: title.height
                Text {
                    id: title
                    text: "InkWise"
                    font.family: root.fontFamily
                    font.pixelSize: Math.round(7 * root.mm)
                    font.bold: true
                }
                Choice {
                    anchors.right: parent.right
                    anchors.verticalCenter: title.verticalCenter
                    label: "Close"
                    onTapped: root.close()
                }
            }
            Body {
                text: "Your Readwise Reader articles on this tablet, and your highlights back in Readwise."
                color: "#333333"
            }

            Rule {}

            // Last sync, or what's happening now
            Body {
                visible: !root.loaded
                text: "Starting…"
            }
            Body {
                visible: root.loaded && !root.app.connected
                text: "Connect to Readwise below to start."
                font.bold: true
            }
            Body {
                visible: root.loaded && root.app.connected && !root.app.last && !root.app.syncing
                text: "Not synced yet."
            }
            Body {
                visible: !!root.app.last && !root.app.syncing
                text: root.app.last ? (root.app.last.ok ? "Last sync " : "Last sync didn’t finish, ") + root.ago(root.app.last.at) : ""
                font.bold: true
            }
            Body {
                visible: !!root.app.last && !root.app.syncing
                text: root.app.last ? root.app.last.summary : ""
            }
            Body {
                visible: root.app.syncing
                text: "Syncing…"
                font.bold: true
            }
            Body {
                visible: root.app.progress !== ""
                text: root.app.progress
                color: "#333333"
                maximumLineCount: 3
                elide: Text.ElideRight
            }

            Choice {
                width: parent.width
                implicitHeight: 15 * root.mm
                label: root.app.syncing ? "Syncing…" : "Sync now"
                enabled: root.loaded && root.app.connected && !root.app.syncing
                onTapped: root.send(2)
            }

            Rule {}

            // Connecting: right under the status, so the field is in view (and above the keyboard).
            Heading {
                visible: !root.app.connected || root.editingToken
                text: "Connect to Readwise"
            }
            Body {
                visible: !root.app.connected || root.editingToken
                text: "Type your access token from readwise.io/access_token."
            }
            Row {
                visible: !root.app.connected || root.editingToken
                width: parent.width
                spacing: 2 * root.mm
                TextField {
                    id: tokenField
                    width: parent.width - saveToken.width - parent.spacing
                    height: 11 * root.mm
                    leftPadding: 2 * root.mm
                    rightPadding: 2 * root.mm
                    verticalAlignment: TextInput.AlignVCenter
                    font.family: root.fontFamily
                    font.pixelSize: root.bodySize
                    color: "black"
                    placeholderText: "Readwise token"
                    inputMethodHints: Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText | Qt.ImhPreferLatin
                    background: Rectangle {
                        border.color: "black"
                        border.width: Math.max(2, Math.round(0.4 * root.mm))
                        radius: 1.5 * root.mm
                    }
                    onAccepted: saveToken.tapped()
                }
                Choice {
                    id: saveToken
                    label: "Save"
                    enabled: tokenField.text.trim() !== ""
                    onTapped: {
                        root.send(4, { token: tokenField.text.trim() });
                        tokenField.text = "";
                        Qt.inputMethod.hide();
                    }
                }
            }
            Choice {
                visible: root.editingToken && root.app.connected
                label: "Cancel"
                onTapped: root.editingToken = false
            }
            Body {
                visible: root.app.tokenMessage !== ""
                text: root.app.tokenMessage
                color: "#333333"
            }

            Rule {
                visible: !root.app.connected || root.editingToken
            }

            Heading { text: "Automatic sync" }
            Flow {
                width: parent.width
                spacing: 2 * root.mm
                Repeater {
                    model: [{ label: "Off", minutes: 0 }, { label: "15 min", minutes: 15 }, { label: "30 min", minutes: 30 }, { label: "1 hour", minutes: 60 }]
                    Choice {
                        required property var modelData
                        label: modelData.label
                        on: root.app.settings.autoSyncMinutes === modelData.minutes
                        onTapped: root.send(3, { autoSyncMinutes: modelData.minutes })
                    }
                }
            }
            Body {
                color: "#333333"
                font.pixelSize: root.smallSize
                text: root.app.settings.autoSyncMinutes
                    ? "Also syncs shortly after the tablet wakes up." + (root.app.nextSyncAt && root.app.connected ? " Next one " + root.fromNow(root.app.nextSyncAt) + "." : "")
                      + " Runs while InkWise has been opened since the tablet last started."
                    : "Only when you tap Sync now."
            }

            Heading { text: "Articles from" }
            Flow {
                width: parent.width
                spacing: 2 * root.mm
                Repeater {
                    model: [{ label: "Later", value: "later" }, { label: "Shortlist", value: "shortlist" }, { label: "Inbox", value: "new" }]
                    Choice {
                        required property var modelData
                        label: modelData.label
                        on: root.app.settings.location === modelData.value
                        onTapped: root.send(3, { location: modelData.value })
                    }
                }
            }

            Rule {}

            Heading {
                visible: root.app.connected && !root.editingToken
                text: "Readwise"
            }
            Body {
                visible: root.app.connected && !root.editingToken
                text: "Connected."
            }
            Choice {
                visible: root.app.connected && !root.editingToken
                label: "Change token"
                onTapped: root.editingToken = true
            }

            Rule {
                visible: root.app.connected && !root.editingToken
            }

            Heading { text: "New articles" }
            Body {
                text: root.app.librarian
                    ? "They appear in the Inkwise folder right away (the librarian mod is installed)."
                    : "The librarian mod isn’t installed, so new articles appear after the reading app next restarts. Install librarian in reManager to see them right away."
            }

            Rule {}

            Heading {
                visible: root.app.log.length > 0
                text: "Recent activity"
            }
            Repeater {
                model: root.app.log.slice(-8).reverse()
                Body {
                    required property string modelData
                    text: root.logLine(modelData)
                    font.pixelSize: root.smallSize
                    color: "#333333"
                }
            }

            Body {
                text: "InkWise " + root.app.version
                font.pixelSize: root.smallSize
                color: "#666666"
            }
        }
    }
}
