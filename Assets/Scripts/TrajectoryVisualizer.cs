using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Visualizes a trajectory using a <see cref="LineRenderer"/> and fades it out over time.
/// </summary>
[RequireComponent(typeof(LineRenderer))]
public class TrajectoryVisualizer : MonoBehaviour
{
    private LineRenderer lineRenderer;

    /// <summary>
    /// Duration in seconds over which the trajectory fades out.
    /// </summary>
    private const float fadeDuration = 1f;

    private float fadeTimer = 0f;
    private Color originalStartColor;
    private Color originalEndColor;

    private void Awake()
    {
        lineRenderer = GetComponent<LineRenderer>();
        originalStartColor = lineRenderer.startColor;
        originalEndColor = lineRenderer.endColor;
    }

    /// <summary>
    /// Renders a trajectory from the provided list of points.
    /// </summary>
    /// <param name="points">The points that define the trajectory.</param>
    public void RenderTrajectory(List<Vector3> points)
    {
        if (points == null || points.Count == 0)
        {
            lineRenderer.positionCount = 0;
            return;
        }

        lineRenderer.positionCount = points.Count;
        lineRenderer.SetPositions(points.ToArray());

        fadeTimer = 0f;
        var startColor = originalStartColor;
        startColor.a = 1f;
        var endColor = originalEndColor;
        endColor.a = 1f;
        lineRenderer.startColor = startColor;
        lineRenderer.endColor = endColor;
    }

    private void Update()
    {
        if (lineRenderer.positionCount == 0)
            return;

        fadeTimer += Time.deltaTime;
        if (fadeTimer <= fadeDuration)
        {
            float t = 1f - (fadeTimer / fadeDuration);
            Color startColor = originalStartColor;
            startColor.a = t;
            Color endColor = originalEndColor;
            endColor.a = t;
            lineRenderer.startColor = startColor;
            lineRenderer.endColor = endColor;
        }
        else
        {
            lineRenderer.positionCount = 0;
        }
    }
}

