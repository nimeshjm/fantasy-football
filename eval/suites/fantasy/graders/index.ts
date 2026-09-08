import type { Grader } from '../../../core/types';
import { conformanceGraders } from './conformance';
import { qualityGraders } from './quality';
import { costGraders } from './cost';

export * from './conformance';
export * from './quality';
export * from './cost';

/** The five axes, kept as separate graders emitting separately-named scores.
 * There is deliberately no weighted total: conformance, legality, regret and
 * cost trade against each other, and collapsing them would hide the one
 * relationship that matters most — that low regret next to zero
 * differentiation means the model added nothing. */
export const fantasyGraders: Grader[] = [...conformanceGraders, ...qualityGraders, ...costGraders];
