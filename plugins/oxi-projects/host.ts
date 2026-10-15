import {chatHostContract} from './chat-watch-contract';
import {readChatSnapshot} from './chat-watch-host';
import {experimental_defineHostEntry} from '@get-bb/plugin-sdk/host';
import {notesHostContract} from './tasknotes-contract';
import {listNotes,readNote} from './tasknotes-host';
import {catalogHostContract} from './catalog-contract';
import {readCatalogLocal} from './catalog-host';
import {readJiraEnv} from './jira-import';
export default experimental_defineHostEntry({contract:{...notesHostContract,...chatHostContract,...catalogHostContract},handlers:{catalogLocal:({sourcePaths},ctx)=>readCatalogLocal(sourcePaths,AbortSignal.any([ctx.signal,ctx.lifecycle.signal])),jiraEnv:({path,prefix},ctx)=>readJiraEnv(path,prefix,AbortSignal.any([ctx.signal,ctx.lifecycle.signal])),chatSnapshot:({databasePath},ctx)=>readChatSnapshot(databasePath,AbortSignal.any([ctx.signal,ctx.lifecycle.signal])),list:(input,ctx)=>listNotes(input,AbortSignal.any([ctx.signal,ctx.lifecycle.signal])),read:({connection,path},ctx)=>readNote(connection,path,AbortSignal.any([ctx.signal,ctx.lifecycle.signal]))}});
