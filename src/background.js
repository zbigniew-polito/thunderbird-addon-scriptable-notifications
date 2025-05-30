// MIT License
// Copyright (c) 2022 Electro Type
// Copyright (c) 2022 Stephan Helma

window.scrNoti = window.scrNoti || {};
const seenMessages = {};
let nativeConnection = null;

window.scrNoti.getScriptType = async () => {
  const { scriptType } = await messenger.storage.local.get({
    scriptType: "simple",
  });
  return scriptType;
};

//==========================================
// On new email...
//==========================================
window.scrNoti.newEmailListener = async (folder, messages) => {

  console.log(folder + "  " + messages.length)

  if (!(await window.scrNoti.isFolderToCheck(folder))) {
    return;
  }

  // Find new messages, which have not been seen yet
  if (messages && messages.messages && messages.messages.length > 0) {

    const scriptType = await window.scrNoti.getScriptType();
    for (const message of messages.messages) {

      //if (message && !message.junk) {
      if (message) {
        if (scriptType == "simple") {
          await window.scrNoti.notifyNativeScript(message, "new");
          return;
        }

        if (!seenMessages[folder.accountId + folder.path].has(message.id)) {
          await window.scrNoti.notifyNativeScript(message, "new");
          console.log("notified")
          seenMessages[folder.accountId + folder.path].add(message.id);
        }
      }
    }
  }
};
browser.messages.onNewMailReceived.removeListener(
  window.scrNoti.newEmailListener
);
browser.messages.onNewMailReceived.addListener(window.scrNoti.newEmailListener);

//==========================================
// On message read...
//==========================================
window.scrNoti.messageOnUpdatedListener = async (
  message,
  changedProperties
) => {
  if (message.junk) {
    return;
  }

  if (!(await window.scrNoti.isFolderToCheck(message.folder))) {
    return;
  }

  if (changedProperties.read) {
    const scriptType = await window.scrNoti.getScriptType();
    if (scriptType == "extended") {
      seenMessages[message.folder.accountId + message.folder.path].delete(message.id);
    }
    await window.scrNoti.notifyNativeScript(message, "read");
  }
};
browser.messages.onUpdated.removeListener(
  window.scrNoti.messageOnUpdatedListener
);
browser.messages.onUpdated.addListener(window.scrNoti.messageOnUpdatedListener);

//==========================================
// On receiving (update) message...
//==========================================
window.scrNoti.onNotifyListener = async (message) => {
  if ("optionsChanged" in message && message.optionsChanged) {

    // Nothing to do for the "simple" mode.
    const scriptType = await window.scrNoti.getScriptType();
    if (scriptType == "simple") {
      return;
    }

    if (nativeConnection != null) {
      nativeConnection.disconnect();
      nativeConnection = null;
    };
    await window.scrNoti.updateSeenMessages();
    await window.scrNoti.notifyNativeScript(null, "start");
  }
};
browser.runtime.onMessage.removeListener(
  window.scrNoti.onNotifyListener
);
browser.runtime.onMessage.addListener(window.scrNoti.onNotifyListener);

//==========================================
// Any unread messages?
//==========================================
window.scrNoti.hasUnreadMessages = async () => {
  const foldersToCheckForUnread =
    await window.scrNoti.getFoldersToCheckForUnread();

  for (const folder of foldersToCheckForUnread) {
    const result = await browser.messages.query({
      unread: true,
      folderId: folder.id,
    });

    if (result && result.messages && result.messages.length > 0) {
      return true;
    }
  }

  return false;
};

//==========================================
// Notify the native script
//==========================================
window.scrNoti.notifyNativeScript = async (message, event) => {
  let payload = null;
  const scriptType = await window.scrNoti.getScriptType();

  switch (scriptType) {
    case "simple":
      switch (event) {
        case "new":
          payload = true;
          break;
        case "read":
        case "deleted":
          payload = await window.scrNoti.hasUnreadMessages();
          break;
        case "start":
          //==========================================
          // For some reason, the folders may not be ready when
          // Thunderbird starts (ex: "Error: Folder not found: /Inbox").
          // So we retry for a couple of times before giving up.
          //==========================================
          payload = await window.scrNoti.tryNbrTimes(window.scrNoti.hasUnreadMessages, 10);
          break;
      };
      break;
    case "extended":
      // List of all accounts
      const accounts = await messenger.accounts.list(false);
      const accountsList = {};
      for (const account of accounts) {
        const identitiesList = [];
        for (const identity of account.identities) {
          const mailIdentity = {
            email: identity.email,
            label: identity.label,
            name: identity.name,
            organization: identity.organization,
          };
          identitiesList.push(mailIdentity);
        };

        const mailAccount = {
          identities: identitiesList,
          name: account.name,
          type: account.type,
        };
        accountsList[account.id] = mailAccount;
      };

      // List of all folders, which should be included
      const foldersToInclude =
        await window.scrNoti.getFoldersToCheckForUnread();
      const foldersList = [];
      for (const folder of foldersToInclude) {
        const folderInfo = await messenger.folders.getFolderInfo(folder.id);
        const folderData = {
          accountId: folder.accountId,
          favorite: folderInfo.favorite,
          name: folder.name,
          path: folder.path,
          totalMessageCount: folderInfo.totalMessageCount,
          type: folder.type,
          unreadMessageCount: folderInfo.unreadMessageCount,
          seenMessageCount: seenMessages[folder.accountId + folder.path].size,
        };
        foldersList.push(folderData);
      };

      // Message data
      if (event == "start") {
        messageDetails = null;
      } else {
        const folder = message.folder;
        messageDetails = {
          author: message.author,
          bccList: message.bbcList,
          ccList: message.ccList,
          date: message.date,
          flagged: message.flagged,
          messageId: message.headerMessageId,
          headersOnly: message.headersOnly,
          junk: message.junk,
          junkScore: message.junkScore,
          read: message.read,
          size: message.size,
          subject: message.subject,
          tags: message.tags,
          folder: {
            accountId: folder.accountId,
            name: folder.name,
            path: folder.path,
            type: folder.type,
          },
        };
      };

      // Assemble entire payload
      payload = {
        accounts: accountsList,
        folders: foldersList,
        event: event,
        message: messageDetails,
      };
      break;
  };

  const { connectionType } = await messenger.storage.local.get({
    connectionType: "connectionless",
  });

  switch (connectionType) {
    case "connectionless":
      await browser.runtime.sendNativeMessage(
        "scriptableNotifications",
        payload
      );
      break;
    case "connectionbased":
      if (nativeConnection == null) {
        nativeConnection = await browser.runtime.connectNative(
          "scriptableNotifications");
      };
      await nativeConnection.postMessage(payload);
      break;
  };

};

//==========================================
// Get the folders to check for unread messages
//==========================================
window.scrNoti.getFoldersToCheckForUnread = async () => {
  const { foldersToCheck } = await messenger.storage.local.get({
    foldersToCheck: [],
  });

  return foldersToCheck;
};

//==========================================
// Is it a folder to check for unread messages?
//==========================================
window.scrNoti.isFolderToCheck = async (folder) => {
  if (!folder) {
    return false;
  }

  const foldersToCheckForUnread =
    await window.scrNoti.getFoldersToCheckForUnread();

  for (const folderToCheck of foldersToCheckForUnread) {
    if (
      folderToCheck.accountId === folder.accountId &&
      folderToCheck.path === folder.path
    ) {
      return true;
    }
  }

  return false;
};

//==========================================
// List all messages in a folder
//==========================================
async function* listMessages(folder) {
  let page = await messenger.messages.list(folder);
  for (let message of page.messages) {
    yield message;
  }

  while (page.id) {
    page = await messenger.messages.continueList(page.id);
    for (let message of page.messages) {
      yield message;
    }
  }
};
window.scrNoti.listMessages = listMessages;

//==========================================
// Retry calling the specified function for X times
// until there are no error, sleeping one second
// between each call.
//
// Throws the error if there is still one at the end.
//==========================================
window.scrNoti.tryNbrTimes = async (fnct, nbrTime) => {
  async function tryNbrTimesInner(pos) {
    try {
      await fnct();
    } catch (error) {
      if (pos >= nbrTime) {
        throw error;
      }

      setTimeout(async () => {
        await tryNbrTimesInner(pos + 1);
      }, 1000);
    }
  }
  await tryNbrTimesInner(1);
};

//==========================================
// Store all unread messages in global variable 'seenMessages'.
//==========================================
window.scrNoti.updateSeenMessages = async () => {
  const scriptType = await window.scrNoti.getScriptType();
  if (scriptType == "simple") {
    return;
  }

  const foldersToCheck = await window.scrNoti.getFoldersToCheckForUnread();
  if (foldersToCheck.length < 1) {
    return;
  }

  for (const folderToCheck of foldersToCheck) {
    const seen = new Set();
    for await (const message of listMessages(folderToCheck)) {
      if (!message.junk && !message.read) {
        seen.add(message.id);
      }
    }
    // Save it
    seenMessages[folderToCheck.accountId + folderToCheck.path] = seen;
  }
};

//==========================================
// On startup...
//==========================================
window.scrNoti.main = async () => {
  const { optionsPageHasBeenShown } = await messenger.storage.local.get({
    optionsPageHasBeenShown: false,
  });

  if (!optionsPageHasBeenShown) {
    await browser.runtime.openOptionsPage();
    return;
  }

  const foldersToCheck = await window.scrNoti.getFoldersToCheckForUnread();
  if (foldersToCheck.length < 1) {
    return;
  }

  await window.scrNoti.updateSeenMessages();
  await window.scrNoti.notifyNativeScript(null, "start");
};
document.addEventListener("DOMContentLoaded", window.scrNoti.main);
