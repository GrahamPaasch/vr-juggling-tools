using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.XR.Interaction.Toolkit;

/// <summary>
/// Provides a menu item that sets up a test scene for juggling in VR.
/// </summary>
public static class SetupJugglingScene
{
    /// <summary>
    /// Creates a new scene named "JugglingTest" with an XR Origin, a pair of
    /// controllers, and a Ball prefab. The scene is saved and opened when the
    /// menu item is executed.
    /// </summary>
    [MenuItem("Tools/Setup Juggling Scene")]
    public static void CreateScene()
    {
        // Ensure the Ball tag exists.
        AddTag("Ball");

        // Create a new scene.
        Scene scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
        scene.name = "JugglingTest";

        // Set up XR Origin with camera and controllers.
        GameObject xrOrigin = new GameObject("XR Origin");
        XROrigin origin = xrOrigin.AddComponent<XROrigin>();

        GameObject cameraOffset = new GameObject("Camera Offset");
        cameraOffset.transform.SetParent(xrOrigin.transform);
        origin.CameraFloorOffsetObject = cameraOffset;

        GameObject cameraGO = new GameObject("Main Camera");
        cameraGO.tag = "MainCamera";
        cameraGO.AddComponent<Camera>();
        cameraGO.transform.SetParent(cameraOffset.transform);
        origin.Camera = cameraGO.GetComponent<Camera>();

        GameObject leftControllerGO = new GameObject("LeftHand Controller");
        leftControllerGO.transform.SetParent(cameraOffset.transform);
        leftControllerGO.AddComponent<ActionBasedController>();
        AttachJugglingHandler(leftControllerGO);

        GameObject rightControllerGO = new GameObject("RightHand Controller");
        rightControllerGO.transform.SetParent(cameraOffset.transform);
        rightControllerGO.AddComponent<ActionBasedController>();
        AttachJugglingHandler(rightControllerGO);

        // Create the Ball prefab.
        GameObject ball = GameObject.CreatePrimitive(PrimitiveType.Sphere);
        ball.name = "Ball";
        ball.tag = "Ball";
        ball.AddComponent<Rigidbody>();
        if (ball.GetComponent<SphereCollider>() == null)
        {
            ball.AddComponent<SphereCollider>();
        }

        PrefabUtility.SaveAsPrefabAsset(ball, "Assets/Ball.prefab");
        Object.DestroyImmediate(ball);

        // Save and open the scene.
        const string scenePath = "Assets/JugglingTest.unity";
        EditorSceneManager.SaveScene(scene, scenePath);
        AssetDatabase.Refresh();
        EditorSceneManager.OpenScene(scenePath);
    }

    /// <summary>
    /// Adds the JugglingInputHandler component to a controller GameObject and
    /// assigns the Ball tag in the inspector if the component exposes a
    /// corresponding field or property.
    /// </summary>
    /// <param name="controller">Controller GameObject.</param>
    private static void AttachJugglingHandler(GameObject controller)
    {
        var handler = controller.AddComponent<JugglingInputHandler>();
        var type = handler.GetType();
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        // Try to assign a field named "ballTag" or "BallTag" if present.
        var field = type.GetField("ballTag", flags) ?? type.GetField("BallTag", flags);
        if (field != null)
        {
            field.SetValue(handler, "Ball");
        }

        // Try to assign a property named "ballTag" or "BallTag" if present.
        var property = type.GetProperty("ballTag", flags) ?? type.GetProperty("BallTag", flags);
        if (property != null && property.CanWrite)
        {
            property.SetValue(handler, "Ball", null);
        }
    }

    /// <summary>
    /// Adds a tag to the TagManager if it does not already exist.
    /// </summary>
    /// <param name="tag">The tag name to ensure.</param>
    private static void AddTag(string tag)
    {
        SerializedObject tagManager = new SerializedObject(AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/TagManager.asset")[0]);
        SerializedProperty tagsProp = tagManager.FindProperty("tags");
        bool found = false;
        for (int i = 0; i < tagsProp.arraySize; ++i)
        {
            SerializedProperty t = tagsProp.GetArrayElementAtIndex(i);
            if (t.stringValue.Equals(tag))
            {
                found = true;
                break;
            }
        }
        if (!found)
        {
            tagsProp.InsertArrayElementAtIndex(0);
            tagsProp.GetArrayElementAtIndex(0).stringValue = tag;
            tagManager.ApplyModifiedProperties();
            AssetDatabase.SaveAssets();
        }
    }
}
