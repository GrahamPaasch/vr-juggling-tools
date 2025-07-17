using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// Displays juggling metrics on a world space canvas positioned in front of the main camera.
/// </summary>
public class JugglingHUD : MonoBehaviour
{
    /// <summary>
    /// The canvas used to render the HUD in world space.
    /// </summary>
    private Canvas hudCanvas;

    /// <summary>
    /// Text displaying the T value.
    /// </summary>
    private Text tText;

    /// <summary>
    /// Text displaying the W value.
    /// </summary>
    private Text wText;

    /// <summary>
    /// Text displaying the H value.
    /// </summary>
    private Text hText;

    /// <summary>
    /// Creates the world space canvas and text elements when the script awakens.
    /// </summary>
    private void Awake()
    {
        CreateCanvas();
    }

    /// <summary>
    /// Creates the canvas and text fields as children of the main camera.
    /// </summary>
    private void CreateCanvas()
    {
        Camera cam = Camera.main;
        if (cam == null)
        {
            Debug.LogError("JugglingHUD requires a Camera tagged as MainCamera.");
            return;
        }

        GameObject canvasObj = new GameObject("JugglingHUDCanvas");
        canvasObj.transform.SetParent(cam.transform);
        canvasObj.transform.localPosition = Vector3.forward * 0.5f;
        canvasObj.transform.localRotation = Quaternion.identity;

        hudCanvas = canvasObj.AddComponent<Canvas>();
        hudCanvas.renderMode = RenderMode.WorldSpace;
        hudCanvas.worldCamera = cam;

        canvasObj.AddComponent<CanvasScaler>();
        canvasObj.AddComponent<GraphicRaycaster>();

        tText = CreateText(canvasObj.transform, "T:");
        wText = CreateText(canvasObj.transform, "W:");
        hText = CreateText(canvasObj.transform, "H:");

        const float lineHeight = 30f;
        tText.rectTransform.anchoredPosition = Vector2.zero;
        wText.rectTransform.anchoredPosition = new Vector2(0f, -lineHeight);
        hText.rectTransform.anchoredPosition = new Vector2(0f, -2f * lineHeight);
    }

    /// <summary>
    /// Helper method to create a text UI element.
    /// </summary>
    /// <param name="parent">Parent transform.</param>
    /// <param name="label">Initial text label.</param>
    /// <returns>The created Text component.</returns>
    private Text CreateText(Transform parent, string label)
    {
        GameObject textObj = new GameObject(label.Replace(":", "") + "Text");
        textObj.transform.SetParent(parent);
        textObj.transform.localScale = Vector3.one;

        Text text = textObj.AddComponent<Text>();
        text.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        text.text = label;
        text.alignment = TextAnchor.MiddleLeft;
        text.rectTransform.sizeDelta = new Vector2(200f, 30f);

        return text;
    }

    /// <summary>
    /// Updates the text elements every frame with the latest juggling metrics.
    /// </summary>
    private void Update()
    {
        if (tText == null)
        {
            return;
        }

        tText.text = $"T: {JugglingPatternMetrics.LastT}";
        wText.text = $"W: {JugglingPatternMetrics.LastW}";
        hText.text = $"H: {JugglingPatternMetrics.LastH}";
    }
}
