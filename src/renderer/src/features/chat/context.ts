// React context shared inside the chat view. Owner: ui-chat.
import { createContext } from 'react';

/** Tool-use ids that currently wait on a pending permission / question / plan request (cards show "Waiting for you"). */
export const AwaitingToolsContext = createContext<ReadonlySet<string>>(new Set());
