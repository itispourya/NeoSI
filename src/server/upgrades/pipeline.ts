export {
  approveCodeUpgrade as approveSelfUpgrade,
  evaluateBenchmarkGate,
  isProtectedPath,
  rejectCodeUpgrade as rejectSelfUpgrade,
  rollbackCodeUpgrade as rollbackSelfUpgrade,
  runCodeEvolutionProposal as runSelfDiagnosticAndProposeUpgrade,
  validateTargetFiles,
} from '../evolution/pipeline.ts';
