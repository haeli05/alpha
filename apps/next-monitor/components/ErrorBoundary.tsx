'use client';

import React, { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{
          padding: '20px',
          margin: '20px',
          border: '1px solid #ff6b6b',
          borderRadius: '8px',
          backgroundColor: '#fff5f5',
        }}>
          <h2 style={{ color: '#c92a2a', marginTop: 0 }}>Something went wrong</h2>
          <p style={{ color: '#666' }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: undefined })}
            style={{
              padding: '8px 16px',
              backgroundColor: '#228be6',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// Functional wrapper for easier use with hooks
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  fallback?: ReactNode
) {
  return function WithErrorBoundary(props: P) {
    return (
      <ErrorBoundary fallback={fallback}>
        <WrappedComponent {...props} />
      </ErrorBoundary>
    );
  };
}

// Error fallback component for charts
export function ChartErrorFallback() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '400px',
      backgroundColor: '#f8f9fa',
      borderRadius: '8px',
      color: '#868e96',
    }}>
      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: '18px', marginBottom: '8px' }}>Failed to load chart</p>
        <p style={{ fontSize: '14px' }}>Please refresh the page to try again</p>
      </div>
    </div>
  );
}

// Error fallback for tables
export function TableErrorFallback() {
  return (
    <div style={{
      padding: '40px',
      textAlign: 'center',
      backgroundColor: '#f8f9fa',
      borderRadius: '8px',
      color: '#868e96',
    }}>
      <p style={{ fontSize: '16px' }}>Failed to load data</p>
      <p style={{ fontSize: '14px' }}>Check your connection and try again</p>
    </div>
  );
}

export default ErrorBoundary;
