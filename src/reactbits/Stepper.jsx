import React, { useState, Children, useRef, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';

import './Stepper.css';

export default function Stepper({
  children,
  initialStep = 1,
  onStepChange = () => {},
  onFinalStepCompleted = () => {},
  stepCircleContainerClassName = '',
  stepContainerClassName = '',
  contentClassName = '',
  footerClassName = '',
  backButtonProps = {},
  nextButtonProps = {},
  backButtonText = 'Back',
  nextButtonText = 'Continue',
  disableStepIndicators = false,
  renderStepIndicator,
  // SmartRecap additions — see the notes on each below.
  canProceed,
  advanceOnComplete = true,
  ...rest
}) {
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [direction, setDirection] = useState(0);
  const stepsArray = Children.toArray(children);
  const totalSteps = stepsArray.length;
  const isCompleted = currentStep > totalSteps;
  const isLastStep = currentStep === totalSteps;

  /**
   * SmartRecap change: a step can only be left once the caller says it is done.
   *
   * Upstream, the step indicators call `updateStep(clicked)` for any step, so
   * they are free jump targets — you can click straight to step 3 and skip
   * every requirement in between. Disabling the Continue button does nothing
   * about that; it just makes the gate look like it exists.
   *
   * `canProceed(step)` returns whether `step` is satisfied. Backward navigation
   * is always allowed — revisiting a finished step is harmless.
   */
  const stepIsSatisfied = step => (typeof canProceed === 'function' ? !!canProceed(step) : true);

  /** The furthest step reachable right now: stop at the first unsatisfied one. */
  const furthestReachable = () => {
    let step = 1;
    while (step <= totalSteps && stepIsSatisfied(step)) step += 1;
    return Math.min(step, totalSteps);
  };

  const updateStep = newStep => {
    setCurrentStep(newStep);
    if (newStep > totalSteps) {
      onFinalStepCompleted();
    } else {
      onStepChange(newStep);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setDirection(-1);
      updateStep(currentStep - 1);
    }
  };

  const handleNext = () => {
    if (isLastStep || !stepIsSatisfied(currentStep)) return;
    setDirection(1);
    updateStep(currentStep + 1);
  };

  /**
   * SmartRecap change: `advanceOnComplete={false}` runs the callback without
   * moving past the last step.
   *
   * Upstream always advances to `totalSteps + 1`, where `isCompleted` hides the
   * footer AND renders `stepsArray[currentStep - 1]`, which is undefined. That
   * state has no content and no buttons. It is invisible when the callback
   * navigates away, and a dead end the moment it does not — a failed submit
   * strands the user on an empty panel with no way back.
   */
  const handleComplete = () => {
    if (!stepIsSatisfied(currentStep)) return;
    if (!advanceOnComplete) {
      onFinalStepCompleted();
      return;
    }
    setDirection(1);
    updateStep(totalSteps + 1);
  };

  /** Indicator clicks: back freely, forward only as far as validation allows. */
  const requestStep = clicked => {
    if (clicked === currentStep) return;
    if (clicked > currentStep && clicked > furthestReachable()) return;
    setDirection(clicked > currentStep ? 1 : -1);
    updateStep(clicked);
  };

  return (
    <div className="outer-container" {...rest}>
      <div className={`step-circle-container ${stepCircleContainerClassName}`} style={{ border: '1px solid #222' }}>
        <div className={`step-indicator-row ${stepContainerClassName}`}>
          {stepsArray.map((_, index) => {
            const stepNumber = index + 1;
            const isNotLastStep = index < totalSteps - 1;
            return (
              <React.Fragment key={stepNumber}>
                {renderStepIndicator ? (
                  renderStepIndicator({
                    step: stepNumber,
                    currentStep,
                    onStepClick: requestStep
                  })
                ) : (
                  <StepIndicator
                    step={stepNumber}
                    disableStepIndicators={disableStepIndicators}
                    // Locked when it sits beyond what validation currently
                    // allows, so it reads as unavailable rather than silently
                    // ignoring the click.
                    locked={stepNumber > currentStep && stepNumber > furthestReachable()}
                    currentStep={currentStep}
                    onClickStep={requestStep}
                  />
                )}
                {isNotLastStep && <StepConnector isComplete={currentStep > stepNumber} />}
              </React.Fragment>
            );
          })}
        </div>

        <StepContentWrapper
          isCompleted={isCompleted}
          currentStep={currentStep}
          direction={direction}
          className={`step-content-default ${contentClassName}`}
        >
          {stepsArray[currentStep - 1]}
        </StepContentWrapper>

        {!isCompleted && (
          <div className={`footer-container ${footerClassName}`}>
            <div className={`footer-nav ${currentStep !== 1 ? 'spread' : 'end'}`}>
              {currentStep !== 1 && (
                <button
                  onClick={handleBack}
                  className={`back-button ${currentStep === 1 ? 'inactive' : ''}`}
                  {...backButtonProps}
                >
                  {backButtonText}
                </button>
              )}
              <button onClick={isLastStep ? handleComplete : handleNext} className="next-button" {...nextButtonProps}>
                {isLastStep ? 'Complete' : nextButtonText}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StepContentWrapper({ isCompleted, currentStep, direction, children, className }) {
  const [parentHeight, setParentHeight] = useState(0);

  return (
    <motion.div
      className={className}
      style={{ position: 'relative', overflow: 'hidden' }}
      animate={{ height: isCompleted ? 0 : parentHeight }}
      transition={{ type: 'spring', duration: 0.4 }}
    >
      <AnimatePresence initial={false} mode="sync" custom={direction}>
        {!isCompleted && (
          <SlideTransition key={currentStep} direction={direction} onHeightReady={h => setParentHeight(h)}>
            {children}
          </SlideTransition>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function SlideTransition({ children, direction, onHeightReady }) {
  const containerRef = useRef(null);

  useLayoutEffect(() => {
    if (containerRef.current) onHeightReady(containerRef.current.offsetHeight);
  }, [children, onHeightReady]);

  return (
    <motion.div
      ref={containerRef}
      custom={direction}
      variants={stepVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: 0.4 }}
      style={{ position: 'absolute', left: 0, right: 0, top: 0 }}
    >
      {children}
    </motion.div>
  );
}

const stepVariants = {
  enter: dir => ({
    x: dir >= 0 ? '-100%' : '100%',
    opacity: 0
  }),
  center: {
    x: '0%',
    opacity: 1
  },
  exit: dir => ({
    x: dir >= 0 ? '50%' : '-50%',
    opacity: 0
  })
};

export function Step({ children }) {
  return <div className="step-default">{children}</div>;
}

function StepIndicator({ step, currentStep, onClickStep, disableStepIndicators, locked = false }) {
  const status = currentStep === step ? 'active' : currentStep < step ? 'inactive' : 'complete';
  const unavailable = disableStepIndicators || locked;

  const handleClick = () => {
    if (step !== currentStep && !unavailable) onClickStep(step);
  };

  return (
    <motion.div
      onClick={handleClick}
      className={`step-indicator ${locked ? 'is-locked' : ''}`}
      style={unavailable ? { pointerEvents: 'none', opacity: disableStepIndicators ? 0.5 : 0.65 } : {}}
      aria-disabled={unavailable || undefined}
      animate={status}
      initial={false}
    >
      <motion.div
        variants={{
          inactive: { scale: 1, backgroundColor: '#222', color: '#a3a3a3' },
          active: { scale: 1, backgroundColor: '#5227FF', color: '#5227FF' },
          complete: { scale: 1, backgroundColor: '#5227FF', color: '#3b82f6' }
        }}
        transition={{ duration: 0.3 }}
        className="step-indicator-inner"
      >
        {status === 'complete' ? (
          <CheckIcon className="check-icon" />
        ) : status === 'active' ? (
          <div className="active-dot" />
        ) : (
          <span className="step-number">{step}</span>
        )}
      </motion.div>
    </motion.div>
  );
}

function StepConnector({ isComplete }) {
  const lineVariants = {
    incomplete: { width: 0, backgroundColor: 'transparent' },
    complete: { width: '100%', backgroundColor: '#5227FF' }
  };

  return (
    <div className="step-connector">
      <motion.div
        className="step-connector-inner"
        variants={lineVariants}
        initial={false}
        animate={isComplete ? 'complete' : 'incomplete'}
        transition={{ duration: 0.4 }}
      />
    </div>
  );
}

function CheckIcon(props) {
  return (
    <svg {...props} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <motion.path
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ delay: 0.1, type: 'tween', ease: 'easeOut', duration: 0.3 }}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}
