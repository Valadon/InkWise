/**
 * Inkwise plugin entry. Order matters: register the component, init the SDK,
 * then register buttons and listeners.
 */
import { AppRegistry, Image } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import App from './App';
import { name as appName } from './app.json';
import { app } from './src/appInstance';
import { BUTTON, screenForButton, screens } from './src/buttons';
import { closeView } from './src/host';
import { quickSend } from './src/services/quickSend';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

const icon = (asset) => Image.resolveAssetSource(asset).uri;

// Sidebar button in both apps: sync the Reader queue.
PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: BUTTON.SYNC,
  name: 'Sync Reader',
  icon: icon(require('./assets/sync.png')),
  showType: 1,
});

// Sidebar button in DOC: finished reading, archive in Reader.
PluginManager.registerButton(1, ['DOC'], {
  id: BUTTON.DONE,
  name: 'Done',
  icon: icon(require('./assets/done.png')),
  showType: 1,
});

// Text-selection toolbar in DOC: send the selection to Readwise. No popup
// (showType 0): the passage gets shaded and the view only opens when there's
// something to show, such as an unmatched highlight or one being edited.
PluginManager.registerButton(3, ['DOC'], {
  id: BUTTON.SEND_HIGHLIGHT,
  name: 'Send highlight',
  icon: icon(require('./assets/highlight.png')),
  showType: 0,
});

PluginManager.registerConfigButton();

PluginManager.registerButtonListener({
  onButtonPress(event) {
    const screen = screenForButton(event.id);
    if (!screen) return;
    const counted = screens.set(screen);
    if (screen === 'highlight' && counted) {
      quickSend(app, { show: () => PluginManager.showPluginView(), close: closeView });
    }
  },
});

PluginManager.registerConfigButtonListener({
  onClick() {
    screens.set('settings');
    PluginManager.showPluginView();
  },
});
