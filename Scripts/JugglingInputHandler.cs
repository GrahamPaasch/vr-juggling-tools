using System;
using UnityEngine;
using UnityEngine.XR.Interaction.Toolkit;

/// <summary>
/// Handles catch and throw events for Ball prefabs using XR Interaction Toolkit.
/// </summary>
public class JugglingInputHandler : MonoBehaviour
{
    /// <summary>
    /// Left hand XR interactor.
    /// </summary>
    [SerializeField] private XRBaseInteractor leftHand;

    /// <summary>
    /// Right hand XR interactor.
    /// </summary>
    [SerializeField] private XRBaseInteractor rightHand;

    /// <summary>
    /// Invoked when a ball is caught. Provides the ball instance and timestamp.
    /// </summary>
    public event Action<GameObject, float> OnCatch;

    /// <summary>
    /// Invoked when a ball is thrown. Provides the ball instance and timestamp.
    /// </summary>
    public event Action<GameObject, float> OnThrow;

    private float tCatch;
    private float tThrow;

    private void OnEnable()
    {
        if (leftHand != null)
        {
            leftHand.selectEntered.AddListener(HandleSelectEntered);
            leftHand.selectExited.AddListener(HandleSelectExited);
        }

        if (rightHand != null)
        {
            rightHand.selectEntered.AddListener(HandleSelectEntered);
            rightHand.selectExited.AddListener(HandleSelectExited);
        }
    }

    private void OnDisable()
    {
        if (leftHand != null)
        {
            leftHand.selectEntered.RemoveListener(HandleSelectEntered);
            leftHand.selectExited.RemoveListener(HandleSelectExited);
        }

        if (rightHand != null)
        {
            rightHand.selectEntered.RemoveListener(HandleSelectEntered);
            rightHand.selectExited.RemoveListener(HandleSelectExited);
        }
    }

    private void HandleSelectEntered(SelectEnterEventArgs args)
    {
        GameObject obj = args.interactableObject.transform.gameObject;
        if (obj.CompareTag("Ball"))
        {
            tCatch = Time.time;
            OnCatch?.Invoke(obj, tCatch);
        }
    }

    private void HandleSelectExited(SelectExitEventArgs args)
    {
        GameObject obj = args.interactableObject.transform.gameObject;
        if (obj.CompareTag("Ball"))
        {
            tThrow = Time.time;
            OnThrow?.Invoke(obj, tThrow);
        }
    }
}
