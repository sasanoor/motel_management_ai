from django.db import transaction
from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from .models import Client, User


class UserSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, required=False, allow_blank=True, min_length=6)
    client_name = serializers.CharField(source="client.name", read_only=True, default=None)
    full_name = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id", "username", "first_name", "last_name", "full_name", "email", "phone",
            "role", "is_active", "client", "client_name", "password", "date_joined",
        ]
        read_only_fields = ["client", "date_joined"]

    def get_full_name(self, obj):
        return obj.get_full_name() or obj.username

    def validate_role(self, value):
        if value not in (User.CLIENT_ADMIN, User.CLIENT_USER, User.MAINTENANCE):
            raise serializers.ValidationError("Role must be Client Admin, Client User or Maintenance.")
        return value

    def create(self, validated_data):
        password = validated_data.pop("password", None)
        if not password:
            raise serializers.ValidationError({"password": "Password is required."})
        user = User(**validated_data)
        user.set_password(password)
        user.save()
        return user

    def update(self, instance, validated_data):
        password = validated_data.pop("password", None)
        for k, v in validated_data.items():
            setattr(instance, k, v)
        if password:
            instance.set_password(password)
        instance.save()
        return instance


class ClientSerializer(serializers.ModelSerializer):
    user_count = serializers.SerializerMethodField()
    room_count = serializers.SerializerMethodField()

    class Meta:
        model = Client
        fields = [
            "id", "name", "address", "city", "state", "zip_code", "phone", "email",
            "is_active", "created_at", "user_count", "room_count",
        ]

    def get_user_count(self, obj):
        return obj.users.count()

    def get_room_count(self, obj):
        return obj.rooms.filter(is_active=True).count()


class ClientOnboardSerializer(ClientSerializer):
    """Creates the motel and its first Client Admin in one step."""

    admin_username = serializers.CharField(write_only=True)
    admin_password = serializers.CharField(write_only=True, min_length=6)
    admin_first_name = serializers.CharField(write_only=True, required=False, allow_blank=True)
    admin_last_name = serializers.CharField(write_only=True, required=False, allow_blank=True)
    admin_email = serializers.EmailField(write_only=True, required=False, allow_blank=True)

    class Meta(ClientSerializer.Meta):
        fields = ClientSerializer.Meta.fields + [
            "admin_username", "admin_password", "admin_first_name", "admin_last_name", "admin_email",
        ]

    def validate_admin_username(self, value):
        if User.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError("Username already taken.")
        return value

    @transaction.atomic
    def create(self, validated_data):
        admin = {
            "username": validated_data.pop("admin_username"),
            "password": validated_data.pop("admin_password"),
            "first_name": validated_data.pop("admin_first_name", ""),
            "last_name": validated_data.pop("admin_last_name", ""),
            "email": validated_data.pop("admin_email", ""),
        }
        client = Client.objects.create(**validated_data)
        password = admin.pop("password")
        user = User(client=client, role=User.CLIENT_ADMIN, **admin)
        user.set_password(password)
        user.save()
        return client


class LoginSerializer(TokenObtainPairSerializer):
    def validate(self, attrs):
        data = super().validate(attrs)
        user = self.user
        if not user.is_super_admin and (not user.client or not user.client.is_active):
            raise serializers.ValidationError(
                {"detail": "Your motel account is inactive. Contact support."}
            )
        data["user"] = UserSerializer(user).data
        return data
