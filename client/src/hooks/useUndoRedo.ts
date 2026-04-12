import { useState, useCallback } from 'react';

interface UndoRedoState<T> {
  current: T;
  past: T[];
  future: T[];
}

/**
 * Generic undo/redo hook for any state type.
 * Maintains a history stack with configurable max depth.
 */
export function useUndoRedo<T>(initialValue: T, maxHistory = 30) {
  const [state, setState] = useState<UndoRedoState<T>>({
    current: initialValue,
    past: [],
    future: [],
  });

  const set = useCallback((newValue: T | ((prev: T) => T)) => {
    setState(prev => {
      const resolved = typeof newValue === 'function'
        ? (newValue as (prev: T) => T)(prev.current)
        : newValue;

      // Don't push if value hasn't changed (shallow compare)
      if (resolved === prev.current) return prev;

      const newPast = [...prev.past, prev.current].slice(-maxHistory);
      return {
        current: resolved,
        past: newPast,
        future: [], // clear redo stack on new action
      };
    });
  }, [maxHistory]);

  const undo = useCallback(() => {
    setState(prev => {
      if (prev.past.length === 0) return prev;
      const previous = prev.past[prev.past.length - 1];
      const newPast = prev.past.slice(0, -1);
      return {
        current: previous,
        past: newPast,
        future: [prev.current, ...prev.future].slice(0, maxHistory),
      };
    });
  }, [maxHistory]);

  const redo = useCallback(() => {
    setState(prev => {
      if (prev.future.length === 0) return prev;
      const next = prev.future[0];
      const newFuture = prev.future.slice(1);
      return {
        current: next,
        past: [...prev.past, prev.current].slice(-maxHistory),
        future: newFuture,
      };
    });
  }, [maxHistory]);

  const reset = useCallback((value: T) => {
    setState({ current: value, past: [], future: [] });
  }, []);

  return {
    value: state.current,
    set,
    undo,
    redo,
    reset,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    historyLength: state.past.length,
  };
}
