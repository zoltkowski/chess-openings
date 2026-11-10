import type { Key } from '@lichess-org/chessground/types';

export type BoardAnnotation = { orig: Key; dest?: Key };

export type MoveNode = {
  id: string;
  parentId: string | null;
  fen: string;
  moveSan: string | null;
  moveUci: string | null;
  stockfishEval?: string | null;
  inactiveStatus?: 'historical' | 'experimental';
  comment?: string;
  annotations?: BoardAnnotation[];
  children: string[];
};

export type MoveTree = {
  rootId: string;
  nodes: Record<string, MoveNode>;
  nextId: number;
};

export type RepertoireMoveStatus = 'main' | 'alternative' | 'historical' | 'experimental';

function moveIds(tree: MoveTree, parent: MoveNode) {
  return parent.children.filter(id => tree.nodes[id]?.moveUci);
}

export function mainMoveId(tree: MoveTree, parent: MoveNode) {
  const children = moveIds(tree, parent);
  return children.find(id => !tree.nodes[id].inactiveStatus) ?? children[0];
}

export function repertoireMoveStatus(tree: MoveTree, parent: MoveNode, move: MoveNode): RepertoireMoveStatus {
  if (move.id === mainMoveId(tree, parent)) return 'main';
  return move.inactiveStatus ?? 'alternative';
}

export function setRepertoireMoveStatus(tree: MoveTree, id: string, status: RepertoireMoveStatus): MoveTree {
  const move = tree.nodes[id];
  const parent = move?.parentId ? tree.nodes[move.parentId] : undefined;
  if (!move?.moveUci || !parent?.children.includes(id)) return tree;
  const current = repertoireMoveStatus(tree, parent, move);
  if (current === status || current === 'main') return tree;

  const inactiveStatus = status === 'historical' || status === 'experimental' ? status : undefined;
  const nodes = { ...tree.nodes, [id]: { ...move, inactiveStatus } };
  if (status === 'main') {
    nodes[parent.id] = { ...parent, children: [id, ...parent.children.filter(childId => childId !== id)] };
  }
  return { ...tree, nodes };
}

export function trainingMoveIds(tree: MoveTree, parent: MoveNode, ownTurn: boolean, includeAlternatives: boolean) {
  if (!ownTurn) return moveIds(tree, parent);
  const main = mainMoveId(tree, parent);
  if (!main) return [];
  if (!includeAlternatives) return [main];
  return moveIds(tree, parent).filter(id => id === main || !tree.nodes[id].inactiveStatus);
}
