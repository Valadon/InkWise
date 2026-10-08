/**
 * Inkwise plugin entry. Order matters: register the component, init the SDK,
 * then register buttons and listeners.
 */
import { AppRegistry, Image } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import App from './App';
import { name as appName } from './app.json';
import { BUTTON, screenForButton, screens } from './src/buttons';

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

// Text-selection toolbar in DOC: send the selection to Readwise.
PluginManager.registerButton(3, ['DOC'], {
  id: BUTTON.SEND_HIGHLIGHT,
  name: 'Send highlight',
  icon: icon(require('./assets/highlight.png')),
  showType: 1,
});

PluginManager.registerConfigButton();

PluginManager.registerButtonListener({
  onButtonPress(event) {
    const screen = screenForButton(event.id);
    if (screen) screens.set(screen);
  },
});

PluginManager.registerConfigButtonListener({
  onClick() {
    screens.set('settings');
    PluginManager.showPluginView();
  },
});
